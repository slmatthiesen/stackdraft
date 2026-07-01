/**
 * The VPC the tier needs — derived from what runs in it, not hard-coded.
 *
 *   • Pure serverless (no EC2, no VPC-bound store/compute) → NO network at all
 *     (Lambda runs outside a VPC; the cost-honest budget default).
 *   • A single EC2 box → one public subnet (the budget single-box posture).
 *   • Any private-subnet workload (Fargate, RDS, ElastiCache, an explicit NAT node)
 *     → a multi-AZ VPC: two public subnets (ALB + NAT live here) and two private
 *     subnets (Fargate/RDS/ElastiCache), with NAT egress. One NAT node → a single
 *     shared NAT (cost-conscious); two NAT nodes → one NAT per AZ (HA, resilient).
 *
 * Subnet names are STABLE so every other emitter can place itself without guessing:
 * `aws_subnet.public_a/public_b` and `aws_subnet.private_a/private_b`. A single-AZ
 * network emits only `public_a`.
 */
import { type EmitCtx } from "./context.js";
import type { HclBlock } from "./hcl.js";

/** True when the tier has a workload that must sit in a private subnet behind NAT. */
export function needsPrivateSubnets(ctx: EmitCtx): boolean {
  return (
    ctx.has("rds") ||
    ctx.has("elasticache") ||
    ctx.has("opensearch") ||
    ctx.has("fargate") ||
    ctx.has("nat")
  );
}

/** True when the tier needs any VPC at all (private workloads OR an EC2 box). */
export function needsVpc(ctx: EmitCtx): boolean {
  return needsPrivateSubnets(ctx) || ctx.has("ec2");
}

export function emitNetwork(ctx: EmitCtx): HclBlock[] {
  if (!needsVpc(ctx)) return [];
  const p = ctx.prefix;
  const azA = `${ctx.region}a`;
  const azB = `${ctx.region}b`;
  const blocks: HclBlock[] = [];

  blocks.push({
    section: "Networking",
    hcl: [
      `resource "aws_vpc" "main" {`,
      `  cidr_block           = "10.0.0.0/16"`,
      `  enable_dns_support   = true`,
      `  enable_dns_hostnames = true`,
      `  tags                 = { Name = "${p}-vpc" }`,
      `}`,
      ``,
      `resource "aws_internet_gateway" "main" {`,
      `  vpc_id = aws_vpc.main.id`,
      `  tags   = { Name = "${p}-igw" }`,
      `}`,
      ``,
      `resource "aws_subnet" "public_a" {`,
      `  vpc_id                  = aws_vpc.main.id`,
      `  cidr_block              = "10.0.0.0/24"`,
      `  availability_zone       = "${azA}"`,
      `  map_public_ip_on_launch = true`,
      `  tags                    = { Name = "${p}-public-a" }`,
      `}`,
      ``,
      `resource "aws_route_table" "public" {`,
      `  vpc_id = aws_vpc.main.id`,
      `  route {`,
      `    cidr_block = "0.0.0.0/0"`,
      `    gateway_id = aws_internet_gateway.main.id`,
      `  }`,
      `  tags = { Name = "${p}-public-rt" }`,
      `}`,
      ``,
      `resource "aws_route_table_association" "public_a" {`,
      `  subnet_id      = aws_subnet.public_a.id`,
      `  route_table_id = aws_route_table.public.id`,
      `}`,
    ].join("\n"),
  });

  if (!needsPrivateSubnets(ctx)) return blocks; // single public subnet is enough

  // Second public subnet — an ALB requires subnets in ≥2 AZs.
  blocks.push({
    section: "Networking",
    hcl: [
      `resource "aws_subnet" "public_b" {`,
      `  vpc_id                  = aws_vpc.main.id`,
      `  cidr_block              = "10.0.1.0/24"`,
      `  availability_zone       = "${azB}"`,
      `  map_public_ip_on_launch = true`,
      `  tags                    = { Name = "${p}-public-b" }`,
      `}`,
      ``,
      `resource "aws_route_table_association" "public_b" {`,
      `  subnet_id      = aws_subnet.public_b.id`,
      `  route_table_id = aws_route_table.public.id`,
      `}`,
      ``,
      `resource "aws_subnet" "private_a" {`,
      `  vpc_id            = aws_vpc.main.id`,
      `  cidr_block        = "10.0.10.0/24"`,
      `  availability_zone = "${azA}"`,
      `  tags              = { Name = "${p}-private-a" }`,
      `}`,
      ``,
      `resource "aws_subnet" "private_b" {`,
      `  vpc_id            = aws_vpc.main.id`,
      `  cidr_block        = "10.0.11.0/24"`,
      `  availability_zone = "${azB}"`,
      `  tags              = { Name = "${p}-private-b" }`,
      `}`,
    ].join("\n"),
  });

  // NAT egress for the private subnets. Two NAT nodes → one per AZ (no cross-AZ SPOF);
  // one (or zero explicit) → a single shared NAT, both private subnets routed to it.
  const perAzNat = ctx.nodesOfKey("nat").length >= 2;
  const natBlocks: string[] = [
    `resource "aws_eip" "nat_a" {`,
    `  domain = "vpc"`,
    `  tags   = { Name = "${p}-nat-a" }`,
    `}`,
    ``,
    `resource "aws_nat_gateway" "a" {`,
    `  allocation_id = aws_eip.nat_a.id`,
    `  subnet_id     = aws_subnet.public_a.id`,
    `  tags          = { Name = "${p}-nat-a" }`,
    `  depends_on    = [aws_internet_gateway.main]`,
    `}`,
    ``,
    `resource "aws_route_table" "private_a" {`,
    `  vpc_id = aws_vpc.main.id`,
    `  route {`,
    `    cidr_block     = "0.0.0.0/0"`,
    `    nat_gateway_id = aws_nat_gateway.a.id`,
    `  }`,
    `  tags = { Name = "${p}-private-a-rt" }`,
    `}`,
    ``,
    `resource "aws_route_table_association" "private_a" {`,
    `  subnet_id      = aws_subnet.private_a.id`,
    `  route_table_id = aws_route_table.private_a.id`,
    `}`,
  ];
  if (perAzNat) {
    natBlocks.push(
      ``,
      `resource "aws_eip" "nat_b" {`,
      `  domain = "vpc"`,
      `  tags   = { Name = "${p}-nat-b" }`,
      `}`,
      ``,
      `resource "aws_nat_gateway" "b" {`,
      `  allocation_id = aws_eip.nat_b.id`,
      `  subnet_id     = aws_subnet.public_b.id`,
      `  tags          = { Name = "${p}-nat-b" }`,
      `  depends_on    = [aws_internet_gateway.main]`,
      `}`,
      ``,
      `resource "aws_route_table" "private_b" {`,
      `  vpc_id = aws_vpc.main.id`,
      `  route {`,
      `    cidr_block     = "0.0.0.0/0"`,
      `    nat_gateway_id = aws_nat_gateway.b.id`,
      `  }`,
      `  tags = { Name = "${p}-private-b-rt" }`,
      `}`,
      ``,
      `resource "aws_route_table_association" "private_b" {`,
      `  subnet_id      = aws_subnet.private_b.id`,
      `  route_table_id = aws_route_table.private_b.id`,
      `}`,
    );
  } else {
    // Single shared NAT — route the AZ-B private subnet through the AZ-A NAT too.
    natBlocks.push(
      ``,
      `resource "aws_route_table_association" "private_b" {`,
      `  subnet_id      = aws_subnet.private_b.id`,
      `  route_table_id = aws_route_table.private_a.id`,
      `}`,
    );
  }
  blocks.push({ section: "Networking", hcl: natBlocks.join("\n") });

  return blocks;
}
