import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { detectWireupGaps } from "../../routes/config.js";
import type { ArchitectureEdge, ArchitectureNode, Tier } from "../../schema/architecture.js";

import { assembleTier } from "./assemble.js";
import { normalizeServiceKey } from "./serviceKey.js";

const n = (id: string, awsService: string, role: string, security: string[] = []): ArchitectureNode => ({
  id,
  awsService,
  role,
  security,
});
const e = (from: string, to: string, payload = "data", protocol = "HTTPS"): ArchitectureEdge => ({
  from,
  to,
  payload,
  protocol,
});

/**
 * A compact tier exercising the whole budget vocabulary AND every edge-wiring kind:
 * a CloudFront edge over an S3 origin + an EC2 origin, a localhost ec2→postgres
 * link, a Lambda reaching the co-located Postgres via SSM, a scheduler→lambda
 * trigger, secrets reads, trace edges, and the alarm→SNS path.
 */
function budgetVocabularyTier(extra: ArchitectureNode[] = [], extraEdges: ArchitectureEdge[] = []): Tier {
  return {
    name: "budget",
    summary: "single box + serverless edge",
    nodes: [
      n("cf", "CloudFront", "CDN + WAF edge", ["WAF managed rules", "TLS only", "access logging"]),
      n("assets", "S3", "asset store", ["SSE-KMS", "block public access", "versioning enabled"]),
      n("box", "EC2 (t4g.small)", "web + orchestrator host", ["public subnet", "IMDSv2 enforced", "EBS encrypted"]),
      n("pg", "Self-managed PostgreSQL + PostGIS", "primary db (localhost)", ["localhost-bound", "KMS-encrypted EBS"]),
      n("render", "Lambda (arm64, 2048 MB)", "headless renderer", ["least-priv role", "reserved concurrency", "idempotent"]),
      n("renders3", "S3", "render output store", ["SSE-KMS", "block public access"]),
      n("backup", "Lambda", "nightly pg_dump scheduler", ["least-priv role", "Secrets Manager creds"]),
      n("sched", "EventBridge Scheduler", "cron trigger", ["least-priv role"]),
      n("secrets", "AWS Secrets Manager", "credentials store", ["KMS-encrypted", "rotation enabled"]),
      n("logs", "CloudWatch Logs", "central log sink", ["retention 30 days", "KMS encrypted"]),
      n("alarms", "CloudWatch Alarms", "golden-signal alarms", ["least-priv role"]),
      n("sns", "SNS", "ops alert topic", ["TLS", "least-priv publish"]),
      n("xray", "AWS X-Ray", "distributed tracing", ["least-priv role"]),
      n("trail", "CloudTrail", "audit trail", ["multi-region trail"]),
      ...extra,
    ],
    edges: [
      e("client", "cf"),
      e("cf", "assets"),
      e("cf", "box"),
      e("box", "pg", "SQL", "TCP (localhost)"),
      e("box", "assets"),
      e("box", "render", "render job", "Lambda invoke"),
      e("box", "secrets"),
      e("box", "logs"),
      e("box", "xray"),
      e("render", "renders3"),
      e("render", "xray"),
      e("sched", "backup", "trigger", "EventBridge"),
      e("backup", "pg", "pg_dump", "TCP (localhost via SSM)"),
      e("backup", "secrets"),
      e("backup", "renders3"),
      e("logs", "alarms"),
      e("alarms", "sns"),
      ...extraEdges,
    ],
    delta: ["baseline single-box posture"],
    costDrivers: [],
    tradeoffs: ["cheapest correct"],
  } as Tier;
}

describe("deterministic Terraform — the zero-wire-up-gaps invariant (plan step 3)", () => {
  const { code, coverage, gaps } = assembleTier(budgetVocabularyTier(), { region: "us-east-1" });

  it("emits ZERO wire-up gaps for a fully-templated budget tier — the contract", () => {
    expect(gaps).toEqual([]);
    // And the same detector the LLM path runs sees the assembled file as clean.
    expect(detectWireupGaps(code)).toEqual([]);
  });

  it("templates the entire budget vocabulary (100% coverage, nothing unsupported)", () => {
    expect(coverage.unsupported).toEqual([]);
    expect(coverage.ratio).toBe(1);
    expect(coverage.templated).toBe(coverage.total);
  });

  it("carries each wire-up consequence as a template invariant", () => {
    // ACM cert is always paired with its validation resource.
    expect(code).toContain('resource "aws_acm_certificate_validation"');
    // No EC2 instance public DNS as a CloudFront origin.
    expect(code).not.toContain("public_dns");
    // The access-log bucket grants the CloudFront log-delivery CanonicalUser.
    expect(code).toContain("CanonicalUser");
    // No rotation resource (a null rotation_lambda_arn is invalid).
    expect(code).not.toContain("aws_secretsmanager_secret_rotation");
  });

  it("a none-sensitivity BUDGET tier carries only the FREE security floor (no WAF / customer CMK / multi-region trail)", () => {
    // Budget = cheapest CORRECT (docs/plans/2026-06-30-005): paid security rides the
    // ladder. The emitter must NOT deploy the WAF web ACL, any customer-managed CMK, or
    // a multi-region trail here — that is the over-build the gate now rejects.
    expect(code).not.toContain('resource "aws_wafv2_web_acl"');
    expect(code).not.toContain('resource "aws_kms_key"');
    expect(code).not.toContain("logs.us-east-1.amazonaws.com"); // no CMK key policy needed
    expect(code).not.toContain("web_acl_id"); // distribution attaches no WAF
    expect(code).toContain("is_multi_region_trail         = false"); // single-region trail
    // At-rest still satisfied — SSE-S3 (AES256) + the AWS-managed SNS key, both free.
    expect(code).toContain('sse_algorithm     = "AES256"');
    expect(code).toContain('kms_master_key_id = "alias/aws/sns"');
  });

  it("the SAME tier UNDER COMPLIANCE pulls the paid floor down into budget", () => {
    // The compliance override: regulated data makes the paid controls correct-required,
    // so a compliance build carries the WAF, customer CMKs, and a multi-region trail
    // even on the budget tier — and still emits ZERO wire-up gaps.
    const c = assembleTier(budgetVocabularyTier(), { region: "us-east-1", compliance: true });
    expect(c.gaps).toEqual([]);
    expect(c.code).toContain('resource "aws_wafv2_web_acl"');
    expect(c.code).toContain('resource "aws_kms_key" "main"');
    expect(c.code).toContain("logs.us-east-1.amazonaws.com"); // CMK key policy present
    expect(c.code).toContain("is_multi_region_trail         = true");
  });

  it("derives least-privilege IAM from the edges, not from prose", () => {
    // The EC2 box reads the secret it has an edge to, and invokes the render Lambda.
    expect(code).toContain("secretsmanager:GetSecretValue");
    expect(code).toContain("lambda:InvokeFunction");
    // A Lambda reaching the co-located Postgres tunnels in via SSM port-forward.
    expect(code).toContain("ssm:StartSession");
    // The CloudFront-fronted box accepts traffic only from the CF managed prefix list,
    // never 0.0.0.0/0; a localhost ec2→postgres link needs no SG of its own.
    expect(code).toContain('data "aws_ec2_managed_prefix_list" "cloudfront"');
    expect(code).toContain("prefix_list_ids");
  });

  it("classifies a 'scheduler'-in-its-role Lambda as a Lambda, not the EventBridge Scheduler", () => {
    // Regression guard: keying off role prose would route `backup` (role: 'nightly
    // pg_dump scheduler') to the scheduler emitter and it would vanish.
    expect(normalizeServiceKey({ awsService: "Lambda", role: "nightly pg_dump scheduler" })).toBe("lambda");
    // Both Lambda functions are present (render + the 'scheduler'-named backup).
    expect(code.match(/resource "aws_lambda_function"/g)?.length).toBe(2);
  });

  it("produces balanced braces/brackets (a coarse parse-ability check)", () => {
    const count = (s: string, c: string): number => s.split(c).length - 1;
    expect(count(code, "{")).toBe(count(code, "}"));
    expect(count(code, "[")).toBe(count(code, "]"));
    expect(code).not.toContain("undefined");
    expect(code).not.toContain("NaN");
  });
});

describe("deterministic Terraform — IAM from edges AND security tags", () => {
  it("grants a secrets read from a security tag even when the graph omits the edge", () => {
    // A worker tagged 'Secrets Manager creds' with NO edge to the secret — a common
    // graph gap. The tag fallback (plan: derive IAM from 'edges + security tags')
    // still grants GetSecretValue so it can fetch credentials at runtime.
    const tier: Tier = {
      name: "budget",
      summary: "tag-only secrets",
      nodes: [
        n("worker", "Lambda", "reconciliation cron", ["least-priv role", "Secrets Manager creds"]),
        n("secrets", "AWS Secrets Manager", "credentials store", ["KMS-encrypted"]),
      ],
      edges: [],
      delta: [],
      costDrivers: [],
      tradeoffs: [],
    } as Tier;
    const { code } = assembleTier(tier, { region: "us-east-1" });
    expect(code).toContain("secretsmanager:GetSecretValue");
  });
});

describe("deterministic Terraform — full dogfood coverage (both real designs)", () => {
  // Two structurally different real designs: happy-hour (CloudFront/WAF, a budget single
  // box, the balanced/resilient managed stack — ALB/Fargate/RDS/ElastiCache/NAT/SQS/
  // EventBridge) and trade-monitoring (serverless — API Gateway/Lambda/DynamoDB/SQS).
  // Every tier of both must template fully with zero wire-up gaps.
  const designs = ["happyhourfriends", "trade-monitoring-handoff"].map(
    (d) =>
      [
        d,
        JSON.parse(readFileSync(new URL(`../../../../../dogfood/${d}/design.json`, import.meta.url), "utf8")) as {
          tiers: Tier[];
        },
      ] as const,
  );
  for (const [name, design] of designs) {
    for (const tier of design.tiers) {
      it(`${name} / ${tier.name}: 100% coverage, zero wire-up gaps`, () => {
        const { coverage, gaps } = assembleTier(tier, { region: "us-east-1" });
        expect(coverage.unsupported).toEqual([]);
        expect(coverage.ratio).toBe(1);
        expect(gaps).toEqual([]);
      });
    }
  }
});

describe("deterministic Terraform — hybrid fallback for unsupported services", () => {
  it("routes an unknown service to a TODO, lowers coverage, and STILL emits zero gaps", () => {
    const tier = budgetVocabularyTier(
      [n("msk", "Amazon Managed Streaming for Apache Kafka (MSK)", "event backbone", ["KMS at rest"])],
      [e("box", "msk")],
    );
    const { code, coverage, gaps } = assembleTier(tier, { region: "us-east-1" });
    expect(coverage.unsupported).toContain("msk");
    expect(coverage.ratio).toBeLessThan(1);
    expect(code).toContain("# TODO: unsupported service");
    expect(gaps).toEqual([]);
  });
});
