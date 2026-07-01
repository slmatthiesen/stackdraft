/**
 * Managed-tier emitters — ALB, Fargate/ECS, RDS, ElastiCache — the always-on
 * private-subnet stack the balanced/resilient tiers add on top of the serverless
 * edge. Security groups are derived from the EDGE list, the same as the rest of the
 * pipeline: an ALB admits 443 only from CloudFront's managed prefix list; a Fargate
 * service admits the ALB's SG on its container port; RDS/ElastiCache admit ONLY the
 * in-VPC compute SGs that actually have an edge to them (Fargate services + any
 * VPC-attached Lambda). The store SGs reference their callers one-directionally, so
 * there's no SG dependency cycle.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { cwLogsKmsLine, inVpcComputeCallers, type EmitCtx } from "../context.js";
import { edgeIamStatements } from "../glue.js";
import { type HclBlock, jsonencode, policyDoc, raw } from "../hcl.js";

const indentPolicy = (json: string): string =>
  json.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");

const dash = (tf: string): string => tf.replace(/_/g, "-");
/** AWS LB / target-group names: ≤32 chars, alphanumeric + hyphen. */
const lbName = (prefix: string, tf: string): string => `${prefix}-${dash(tf)}`.slice(0, 32).replace(/-+$/, "");
/** OpenSearch domain names: 3–28 chars, lowercase, start with a letter, [a-z0-9-]. */
const domainName = (prefix: string, tf: string): string =>
  `${prefix}-${dash(tf)}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 28).replace(/-+$/, "");

/** Parse an instance class like `db.t4g.medium` / `cache.t4g.micro` from the surface. */
function parseClass(node: ArchitectureNode, fallback: string): string {
  const m = /\b((?:db|cache)\.[a-z0-9]+\.[a-z0-9]+)\b/.exec(`${node.awsService} ${node.role}`.toLowerCase());
  return m ? m[1]! : fallback;
}
const isMultiAz = (node: ArchitectureNode): boolean => /multi-az|multi az/i.test(`${node.awsService} ${node.role}`);

/** The CloudFront managed prefix list (shared, deduped — glue emits it too). */
const cfPrefixListBlock: HclBlock = {
  section: "Networking",
  dedupeKey: "cf-prefix-list",
  hcl: [
    `data "aws_ec2_managed_prefix_list" "cloudfront" {`,
    `  name = "com.amazonaws.global.cloudfront.origin-facing"`,
    `}`,
  ].join("\n"),
};

// --- ALB ---------------------------------------------------------------------

export function emitAlb(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `Application Load Balancer — ${node.role}`;
  const frontedByCf = ctx.in(node.id).some((e) => {
    const f = ctx.byId(e.from);
    return f && ctx.keyOf(f) === "cloudfront";
  });
  const targets = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) === "fargate");

  const blocks: HclBlock[] = [];
  if (frontedByCf) blocks.push(cfPrefixListBlock);

  const ingress = frontedByCf
    ? [
        `  ingress {`,
        `    description     = "HTTPS from CloudFront only"`,
        `    from_port       = 443`,
        `    to_port         = 443`,
        `    protocol        = "tcp"`,
        `    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]`,
        `  }`,
      ]
    : [
        `  ingress {`,
        `    description = "HTTPS from the internet"`,
        `    from_port   = 443`,
        `    to_port     = 443`,
        `    protocol    = "tcp"`,
        `    cidr_blocks = ["0.0.0.0/0"]`,
        `  }`,
      ];

  blocks.push({
    section,
    hcl: [
      `resource "aws_security_group" "${tf}" {`,
      `  name        = "${ctx.prefix}-${dash(tf)}-sg"`,
      `  description = "ALB ingress for ${node.role}"`,
      `  vpc_id      = aws_vpc.main.id`,
      ...ingress,
      `  egress {`,
      `    description = "To the application targets"`,
      `    from_port   = 0`,
      `    to_port     = 0`,
      `    protocol    = "-1"`,
      `    cidr_blocks = ["0.0.0.0/0"]`,
      `  }`,
      `  tags = { Name = "${ctx.prefix}-${dash(tf)}-sg" }`,
      `}`,
      ``,
      `resource "aws_lb" "${tf}" {`,
      `  name               = "${lbName(ctx.prefix, tf)}"`,
      `  load_balancer_type = "application"`,
      `  security_groups    = [aws_security_group.${tf}.id]`,
      `  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]`,
      `}`,
    ].join("\n"),
  });

  // One target group per Fargate target; container port 3000 (Next.js default).
  for (const t of targets) {
    const ttf = ctx.tf(t.id);
    blocks.push({
      section,
      hcl: [
        `resource "aws_lb_target_group" "${ttf}" {`,
        `  name        = "${lbName(ctx.prefix, ttf)}"`,
        `  port        = 3000`,
        `  protocol    = "HTTP"`,
        `  target_type = "ip"`,
        `  vpc_id      = aws_vpc.main.id`,
        `  health_check {`,
        `    path                = "/"`,
        `    matcher             = "200-399"`,
        `    healthy_threshold   = 2`,
        `    unhealthy_threshold = 3`,
        `  }`,
        `}`,
      ].join("\n"),
    });
  }

  const primary = targets[0];
  const listenerLines: string[] = [
    `resource "aws_lb_listener" "${tf}_https" {`,
    `  load_balancer_arn = aws_lb.${tf}.arn`,
    `  port              = 443`,
    `  protocol          = "HTTPS"`,
    `  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"`,
    `  certificate_arn   = var.alb_certificate_arn`,
    `  default_action {`,
    `    type             = "${primary ? "forward" : "fixed-response"}"`,
    ...(primary
      ? [`    target_group_arn = aws_lb_target_group.${ctx.tf(primary.id)}.arn`]
      : [
          `    fixed_response {`,
          `      content_type = "text/plain"`,
          `      message_body = "no backend"`,
          `      status_code  = "503"`,
          `    }`,
        ]),
    `  }`,
    `}`,
  ];
  blocks.push({ section, hcl: listenerLines.join("\n") });

  // Extra targets (beyond the default) get a path-routed listener rule.
  targets.slice(1).forEach((t, i) => {
    const ttf = ctx.tf(t.id);
    blocks.push({
      section,
      hcl: [
        `resource "aws_lb_listener_rule" "${ttf}" {`,
        `  listener_arn = aws_lb_listener.${tf}_https.arn`,
        `  priority     = ${10 + i}`,
        `  action {`,
        `    type             = "forward"`,
        `    target_group_arn = aws_lb_target_group.${ttf}.arn`,
        `  }`,
        `  condition {`,
        `    path_pattern {`,
        `      values = ["/${dash(ttf)}/*"]`,
        `    }`,
        `  }`,
        `}`,
      ].join("\n"),
    });
  });

  return blocks;
}

// --- Fargate / ECS -----------------------------------------------------------

export function emitFargate(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `Fargate — ${node.role}`;
  const blocks: HclBlock[] = [];

  // Shared cluster + execution role + task-assume doc (one per tier).
  blocks.push({
    section: "ECS cluster",
    dedupeKey: "ecs-cluster",
    hcl: [
      `resource "aws_ecs_cluster" "main" {`,
      `  name = "${ctx.prefix}-cluster"`,
      `  setting {`,
      `    name  = "containerInsights"`,
      `    value = "enabled"`,
      `  }`,
      `}`,
    ].join("\n"),
  });
  blocks.push({
    section: "ECS cluster",
    dedupeKey: "ecs-task-assume",
    hcl: [
      `data "aws_iam_policy_document" "ecs_tasks_assume" {`,
      `  statement {`,
      `    actions = ["sts:AssumeRole"]`,
      `    principals {`,
      `      type        = "Service"`,
      `      identifiers = ["ecs-tasks.amazonaws.com"]`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n"),
  });
  blocks.push({
    section: "ECS cluster",
    dedupeKey: "fargate-exec-role",
    hcl: [
      `resource "aws_iam_role" "fargate_exec" {`,
      `  name               = "${ctx.prefix}-fargate-exec"`,
      `  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json`,
      `}`,
      ``,
      `resource "aws_iam_role_policy_attachment" "fargate_exec" {`,
      `  role       = aws_iam_role.fargate_exec.name`,
      `  policy_arn = "arn:\${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"`,
      `}`,
    ].join("\n"),
  });

  // Task role (edge-derived least-priv) + log group.
  const taskStatements = edgeIamStatements(node, ctx);
  const roleLines = [
    `resource "aws_cloudwatch_log_group" "${tf}" {`,
    `  name              = "/ecs/${ctx.prefix}/${dash(tf)}"`,
    `  retention_in_days = 30`,
    ...cwLogsKmsLine(ctx),
    `}`,
    ``,
    `resource "aws_iam_role" "${tf}" {`,
    `  name               = "${ctx.prefix}-${dash(tf)}-task"`,
    `  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json`,
    `}`,
  ];
  if (taskStatements.length > 0) {
    roleLines.push(
      ``,
      `resource "aws_iam_role_policy" "${tf}_task" {`,
      `  name   = "${ctx.prefix}-${dash(tf)}-task"`,
      `  role   = aws_iam_role.${tf}.id`,
      `  policy = ${indentPolicy(jsonencode(policyDoc(taskStatements)))}`,
      `}`,
    );
  }
  blocks.push({ section, hcl: roleLines.join("\n") });

  // Service SG — admits the ALB SG on the container port when an ALB fronts it.
  const albSource = ctx
    .in(node.id)
    .map((e) => ctx.byId(e.from))
    .find((n) => n && ctx.keyOf(n) === "alb");
  const behindAlb = !!albSource;
  blocks.push({
    section,
    hcl: [
      `resource "aws_security_group" "${tf}" {`,
      `  name        = "${ctx.prefix}-${dash(tf)}-sg"`,
      `  description = "Fargate service ${node.role}"`,
      `  vpc_id      = aws_vpc.main.id`,
      ...(behindAlb
        ? [
            `  ingress {`,
            `    description     = "From the ALB on the container port"`,
            `    from_port       = 3000`,
            `    to_port         = 3000`,
            `    protocol        = "tcp"`,
            `    security_groups = [aws_security_group.${ctx.tf(albSource!.id)}.id]`,
            `  }`,
          ]
        : []),
      `  egress {`,
      `    description = "All outbound (NAT + VPC services)"`,
      `    from_port   = 0`,
      `    to_port     = 0`,
      `    protocol    = "-1"`,
      `    cidr_blocks = ["0.0.0.0/0"]`,
      `  }`,
      `  tags = { Name = "${ctx.prefix}-${dash(tf)}-sg" }`,
      `}`,
    ].join("\n"),
  });

  // Task definition + service.
  const desired = /(\d+)\s*task/i.exec(node.role)?.[1] ?? "2";
  const containerDef = jsonencode([
    {
      name: dash(tf),
      image: "PLACEHOLDER_ECR_IMAGE_URI", // replace with your pushed image
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: "tcp" }],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": raw(`aws_cloudwatch_log_group.${tf}.name`),
          "awslogs-region": raw("local.region"),
          "awslogs-stream-prefix": dash(tf),
        },
      },
    },
  ]);
  const svcLines = [
    `resource "aws_ecs_task_definition" "${tf}" {`,
    `  family                   = "${ctx.prefix}-${dash(tf)}"`,
    `  requires_compatibilities = ["FARGATE"]`,
    `  network_mode             = "awsvpc"`,
    `  cpu                      = "512"`,
    `  memory                   = "1024"`,
    `  execution_role_arn       = aws_iam_role.fargate_exec.arn`,
    `  task_role_arn            = aws_iam_role.${tf}.arn`,
    `  container_definitions    = ${indentPolicy(containerDef)}`,
    `}`,
    ``,
    `resource "aws_ecs_service" "${tf}" {`,
    `  name            = "${ctx.prefix}-${dash(tf)}"`,
    `  cluster         = aws_ecs_cluster.main.id`,
    `  task_definition = aws_ecs_task_definition.${tf}.arn`,
    `  desired_count   = ${desired}`,
    `  launch_type     = "FARGATE"`,
    `  network_configuration {`,
    `    subnets          = [aws_subnet.private_a.id, aws_subnet.private_b.id]`,
    `    security_groups  = [aws_security_group.${tf}.id]`,
    `    assign_public_ip = false`,
    `  }`,
  ];
  if (behindAlb) {
    svcLines.push(
      `  load_balancer {`,
      `    target_group_arn = aws_lb_target_group.${tf}.arn`,
      `    container_name   = "${dash(tf)}"`,
      `    container_port   = 3000`,
      `  }`,
      `  depends_on = [aws_lb_listener.${ctx.tf(albSource!.id)}_https]`,
    );
  }
  svcLines.push(`}`);
  blocks.push({ section, hcl: svcLines.join("\n") });

  return blocks;
}

// --- RDS ---------------------------------------------------------------------

export function emitRds(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `RDS — ${node.role}`;
  const callers = inVpcComputeCallers(ctx, node.id);

  const ingress = callers.length
    ? callers.flatMap((c) => [
        `  ingress {`,
        `    description     = "PostgreSQL from ${c.role}"`,
        `    from_port       = 5432`,
        `    to_port         = 5432`,
        `    protocol        = "tcp"`,
        `    security_groups = [aws_security_group.${ctx.tf(c.id)}.id]`,
        `  }`,
      ])
    : [];

  return [
    {
      section,
      hcl: [
        `resource "aws_db_subnet_group" "${tf}" {`,
        `  name       = "${ctx.prefix}-${dash(tf)}"`,
        `  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]`,
        `}`,
        ``,
        `resource "aws_security_group" "${tf}" {`,
        `  name        = "${ctx.prefix}-${dash(tf)}-sg"`,
        `  description = "RDS ${node.role} — ingress only from in-VPC callers"`,
        `  vpc_id      = aws_vpc.main.id`,
        ...ingress,
        `}`,
        ``,
        `resource "aws_db_instance" "${tf}" {`,
        `  identifier                  = "${ctx.prefix}-${dash(tf)}"`,
        `  engine                      = "postgres"`,
        `  instance_class              = "${parseClass(node, "db.t4g.medium")}"`,
        `  allocated_storage           = 20`,
        `  max_allocated_storage       = 100`,
        `  storage_type                = "gp3"`,
        `  storage_encrypted           = true`,
        ...(ctx.paidSecurity ? [`  kms_key_id                  = aws_kms_key.main.arn`] : []),
        `  db_subnet_group_name        = aws_db_subnet_group.${tf}.name`,
        `  vpc_security_group_ids      = [aws_security_group.${tf}.id]`,
        `  db_name                     = "appdb"`,
        `  username                    = "appuser"`,
        `  manage_master_user_password = true`,
        `  multi_az                    = ${isMultiAz(node)}`,
        `  backup_retention_period     = 7`,
        `  deletion_protection         = false`,
        `  skip_final_snapshot         = true`,
        `}`,
      ].join("\n"),
    },
  ];
}

// --- ElastiCache -------------------------------------------------------------

export function emitElasticache(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `ElastiCache — ${node.role}`;
  const callers = inVpcComputeCallers(ctx, node.id);
  const multiAz = isMultiAz(node);

  const ingress = callers.length
    ? callers.flatMap((c) => [
        `  ingress {`,
        `    description     = "Redis from ${c.role}"`,
        `    from_port       = 6379`,
        `    to_port         = 6379`,
        `    protocol        = "tcp"`,
        `    security_groups = [aws_security_group.${ctx.tf(c.id)}.id]`,
        `  }`,
      ])
    : [];

  return [
    {
      section,
      hcl: [
        `resource "aws_elasticache_subnet_group" "${tf}" {`,
        `  name       = "${ctx.prefix}-${dash(tf)}"`,
        `  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]`,
        `}`,
        ``,
        `resource "aws_security_group" "${tf}" {`,
        `  name        = "${ctx.prefix}-${dash(tf)}-sg"`,
        `  description = "ElastiCache ${node.role} — ingress only from in-VPC callers"`,
        `  vpc_id      = aws_vpc.main.id`,
        ...ingress,
        `}`,
        ``,
        `resource "aws_elasticache_replication_group" "${tf}" {`,
        `  replication_group_id       = "${lbName(ctx.prefix, tf)}"`,
        `  description                = "${node.role}"`,
        `  engine                     = "redis"`,
        `  node_type                  = "${parseClass(node, "cache.t4g.micro")}"`,
        `  num_cache_clusters         = ${multiAz ? 2 : 1}`,
        `  automatic_failover_enabled = ${multiAz}`,
        `  multi_az_enabled           = ${multiAz}`,
        `  at_rest_encryption_enabled = true`,
        `  transit_encryption_enabled = true`,
        `  subnet_group_name          = aws_elasticache_subnet_group.${tf}.name`,
        `  security_group_ids         = [aws_security_group.${tf}.id]`,
        `  port                       = 6379`,
        `}`,
      ].join("\n"),
    },
  ];
}

// --- OpenSearch --------------------------------------------------------------

/** OpenSearch instance class parsed from the surface (e.g. "r6g.large.search"),
 *  defaulting to a small general-purpose node. Distinct from parseClass — OpenSearch
 *  classes are bare (no db./cache. prefix) and end in `.search`. */
function parseSearchClass(node: ArchitectureNode): string {
  const m = /\b([a-z][0-9][a-z]?g?\.[a-z0-9]+\.search)\b/.exec(`${node.awsService} ${node.role}`.toLowerCase());
  return m ? m[1]! : "t3.small.search";
}

export function emitOpenSearch(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `OpenSearch — ${node.role}`;
  const callers = inVpcComputeCallers(ctx, node.id);
  const multiAz = isMultiAz(node);

  const ingress = callers.length
    ? callers.flatMap((c) => [
        `  ingress {`,
        `    description     = "HTTPS from ${c.role}"`,
        `    from_port       = 443`,
        `    to_port         = 443`,
        `    protocol        = "tcp"`,
        `    security_groups = [aws_security_group.${ctx.tf(c.id)}.id]`,
        `  }`,
      ])
    : [];

  return [
    {
      section,
      hcl: [
        `resource "aws_security_group" "${tf}" {`,
        `  name        = "${ctx.prefix}-${dash(tf)}-sg"`,
        `  description = "OpenSearch ${node.role} — ingress only from in-VPC callers"`,
        `  vpc_id      = aws_vpc.main.id`,
        ...ingress,
        `}`,
        ``,
        `resource "aws_opensearch_domain" "${tf}" {`,
        `  domain_name    = "${domainName(ctx.prefix, tf)}"`,
        `  engine_version = "OpenSearch_2.11"`,
        ``,
        `  cluster_config {`,
        `    instance_type          = "${parseSearchClass(node)}"`,
        `    instance_count         = ${multiAz ? 2 : 1}`,
        `    zone_awareness_enabled = ${multiAz}`,
        ...(multiAz
          ? [`    zone_awareness_config {`, `      availability_zone_count = 2`, `    }`]
          : []),
        `  }`,
        ``,
        `  ebs_options {`,
        `    ebs_enabled = true`,
        `    volume_type = "gp3"`,
        `    volume_size = 20`,
        `  }`,
        ``,
        `  vpc_options {`,
        `    subnet_ids         = [${multiAz ? "aws_subnet.private_a.id, aws_subnet.private_b.id" : "aws_subnet.private_a.id"}]`,
        `    security_group_ids = [aws_security_group.${tf}.id]`,
        `  }`,
        ``,
        `  encrypt_at_rest {`,
        `    enabled = true`,
        // Budget floor: the AWS-owned OpenSearch key (free). Balanced+/compliance: a CMK.
        ...(ctx.paidSecurity ? [`    kms_key_id = aws_kms_key.main.arn`] : []),
        `  }`,
        ``,
        `  node_to_node_encryption {`,
        `    enabled = true`,
        `  }`,
        ``,
        `  domain_endpoint_options {`,
        `    enforce_https       = true`,
        `    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"`,
        `  }`,
        `}`,
      ].join("\n"),
    },
  ];
}
