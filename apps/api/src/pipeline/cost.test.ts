import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { seedKnowledgeBase } from "../store/kbLoader.js";
import type {
  ArchitectureNode,
  ArchitectureResult,
  Tier,
} from "../schema/architecture.js";

import {
  estimateCosts,
  formatRange,
  onDemandDisclaimer,
  ASSUMED_MONTHLY_VOLUME,
} from "./cost.js";

const REGION = "us-east-1";

function node(awsService: string, over: Partial<ArchitectureNode> = {}): ArchitectureNode {
  return {
    id: awsService.toLowerCase().replace(/\s+/g, "-"),
    awsService,
    role: `${awsService} node`,
    security: ["TLS", "least-privilege role"],
    ...over,
  };
}

function tier(name: Tier["name"], nodes: ArchitectureNode[], delta: string[]): Tier {
  return {
    name,
    summary: `${name} tier`,
    nodes,
    edges: [],
    // LLM placeholder cost drivers — the estimator fills these deterministically.
    costDrivers: [{ service: "placeholder", unit: "?", estimateRange: "?", note: "" }],
    delta,
    tradeoffs: ["vs other"],
  };
}

// The global security floor mandates a private data tier (no public data tier);
// combined with a tier's RDS/ElastiCache/EC2 service it forces the NAT/egress cost.
const SECURITY_FLOOR = [
  "Encryption at rest with KMS / SSE.",
  "TLS in transit; HTTPS only.",
  "Least-privilege IAM, no long-lived keys.",
  "S3 Block Public Access on.",
  "Data tier in private subnets, no public route.",
  "Secrets in AWS Secrets Manager.",
  "Edge protection: CloudFront + WAF.",
  "CloudTrail + access logging.",
];

// A container tier whose data tier (RDS) sits in a private subnet → NAT/egress
// cost is forced (R6/R7 #5). A serverless tier with no private subnet → no NAT.
const RECOMMENDATION: Pick<
  ArchitectureResult,
  "recommendedTier" | "recommendationRationale" | "keyDecisions"
> = {
  recommendedTier: "balanced",
  recommendationRationale: "Balanced fits the assumed ~1M req/mo with multi-AZ availability.",
  keyDecisions: [
    {
      decision: "Compute model",
      chosen: "Fargate behind an ALB",
      alternativesConsidered: ["Lambda", "EC2 ASG"],
      rationale: "Long-running, steady CPU work suits containers over per-request billing.",
    },
  ],
};

function result(): ArchitectureResult {
  return {
    assumptions: ["assumes ~1M requests/month"],
    clarificationsUsed: [],
    securityFloor: SECURITY_FLOOR,
    ...RECOMMENDATION,
    tiers: [
      // Balanced trips the NAT/egress cost via its RDS data tier + the floor's
      // private-subnet mandate (no private-subnet tag needed on the node).
      tier(
        "balanced",
        [node("ALB"), node("Fargate"), node("RDS"), node("CloudFront"), node("WAF")],
        ["+ multi-AZ RDS", "+ read replica"],
      ),
      // Budget is serverless (Lambda + DynamoDB, no VPC) — no private data service,
      // no private-subnet signal → no NAT/egress line.
      tier(
        "budget",
        [node("Lambda"), node("API Gateway"), node("DynamoDB"), node("S3")],
        ["baseline: serverless, no VPC, no NAT required"],
      ),
    ],
  };
}

describe("estimateCosts", () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores); // loads the offline pricing seed into the store
  });

  it("maps a private-subnet tier to native-unit ranges incl. a NAT/egress line (R6)", () => {
    const out = estimateCosts(result(), stores.pricing, REGION);
    const balanced = out.tiers[0]!;

    // Every driver is a range string in $/mo form.
    for (const d of balanced.costDrivers) {
      expect(d.estimateRange).toMatch(/^\$[\d.]+–\$[\d.]+\/mo$/);
    }

    // ALB ($/hr) range computed from the SAME band + cached price (no drift).
    const albPrice = stores.pricing.get("ALB", REGION).find((r) => r.unit === "hour")!;
    const band = ASSUMED_MONTHLY_VOLUME["hour"]!;
    const albDriver = balanced.costDrivers.find((d) => d.service === "ALB" && d.unit === "$/hr")!;
    expect(albDriver.estimateRange).toBe(formatRange(albPrice.usd * band.low, albPrice.usd * band.high));

    // The forced NAT-gateway line is present, in its native units, and flagged.
    const natProcessed = balanced.costDrivers.find(
      (d) => d.service === "NAT Gateway" && d.unit === "$/GB processed",
    );
    expect(natProcessed).toBeDefined();
    expect(natProcessed!.note).toMatch(/private-subnet security default/i);

    const natHour = balanced.costDrivers.find((d) => d.service === "NAT Gateway" && d.unit === "$/hr");
    expect(natHour).toBeDefined();

    // The internet-egress data-transfer line is present and flagged.
    const egress = balanced.costDrivers.find(
      (d) => d.service === "Data Transfer" && d.unit === "$/GB internet egress",
    );
    expect(egress).toBeDefined();
    expect(egress!.note).toMatch(/private-subnet security default/i);
  });

  it("does NOT add a NAT/egress line for a tier with no private subnet", () => {
    const out = estimateCosts(result(), stores.pricing, REGION);
    const budget = out.tiers[1]!;
    expect(budget.costDrivers.some((d) => d.service === "NAT Gateway")).toBe(false);
    expect(budget.costDrivers.some((d) => d.service === "Data Transfer")).toBe(false);

    // Lambda carries BOTH native units (per-1k requests + $/GB-second).
    const units = budget.costDrivers.filter((d) => d.service === "Lambda").map((d) => d.unit);
    expect(units).toContain("per 1k requests");
    expect(units).toContain("$/GB-second");
  });

  it("falls back to the seed and flags approximate when the cache lacks a service", () => {
    // Hand-seeded store with ONLY Lambda — DynamoDB/API Gateway are missing.
    const empty = createStores(openTempDb());
    empty.pricing.replaceMonth(REGION, "2026-06", [
      { service: "Lambda", region: REGION, unit: "per-1k-requests", usd: 0.0002, month: "2026-06", note: "cached" },
    ]);

    const serverless: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier("budget", [node("Lambda"), node("DynamoDB")], ["baseline: serverless, no VPC, no NAT"]),
      ],
    };

    const out = estimateCosts(serverless, empty.pricing, REGION);
    const drivers = out.tiers[0]!.costDrivers;

    const lambda = drivers.find((d) => d.service === "Lambda")!;
    expect(lambda.note).not.toMatch(/approximate/i); // cached, exact

    const dynamo = drivers.filter((d) => d.service === "DynamoDB");
    expect(dynamo.length).toBeGreaterThan(0);
    for (const d of dynamo) {
      expect(d.note).toMatch(/^approximate/i); // seed fallback flagged
    }
  });

  it("attaches the on-demand-list-price disclaimer to assumptions (R6)", () => {
    const out = estimateCosts(result(), stores.pricing, REGION);
    expect(out.assumptions).toContain(onDemandDisclaimer(REGION));
    const disclaimer = out.assumptions.find((a) => a.includes("on-demand list prices"))!;
    expect(disclaimer).toMatch(/Free Tier/);
    expect(disclaimer).toMatch(/Savings Plans|Reserved/);

    // Idempotent: re-running does not duplicate the disclaimer.
    const twice = estimateCosts(out, stores.pricing, REGION);
    expect(twice.assumptions.filter((a) => a === onDemandDisclaimer(REGION))).toHaveLength(1);
  });
});
