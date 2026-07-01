import { describe, it, expect } from "vitest";

import { detectWireupGaps } from "../../../routes/config.js";
import type { ArchitectureEdge, ArchitectureNode, Tier } from "../../../schema/architecture.js";

import { assembleTier } from "../assemble.js";
import { normalizeServiceKey } from "../serviceKey.js";

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
 * A serverless tier exercising the newly-templated vocabulary — Cognito, SES, Step
 * Functions, Kinesis, OpenSearch — all reached from one API Lambda, plus a stream
 * consumer and a workflow worker. Previously every one of these routed the WHOLE
 * tier to the LLM fallback; the invariant now is 100% coverage + zero wire-up gaps.
 */
function integrationTier(name: "budget" | "balanced" = "budget"): Tier {
  return {
    name,
    summary: "serverless API with auth, email, streaming, orchestration, search",
    nodes: [
      n("gw", "API Gateway", "http front door", ["throttling"]),
      n("api", "Lambda", "api handler", ["least-priv role"]),
      n("auth", "Amazon Cognito", "user pool", ["MFA optional"]),
      n("mail", "Amazon SES", "transactional email", ["event publishing"]),
      n("stream", "Amazon Kinesis Data Streams", "event ingest", ["KMS at rest"]),
      n("consumer", "Lambda", "stream consumer", ["idempotent consumer"]),
      n("flow", "AWS Step Functions", "onboarding workflow", ["least-priv role"]),
      n("worker", "Lambda", "workflow task", ["least-priv role"]),
      n("search", "Amazon OpenSearch Service", "product search (multi-AZ)", ["private subnet", "TLS"]),
      n("logs", "CloudWatch Logs", "central log sink", ["retention 30 days"]),
      n("sns", "SNS", "ops alert topic", ["TLS"]),
      n("alarms", "CloudWatch Alarms", "golden-signal alarms", []),
    ],
    edges: [
      e("client", "gw"),
      e("gw", "api", "request", "HTTPS"),
      e("api", "auth", "AdminInitiateAuth", "HTTPS"),
      e("api", "mail", "send receipt", "HTTPS"),
      e("api", "stream", "put record", "HTTPS"),
      e("api", "flow", "StartExecution", "HTTPS"),
      e("api", "search", "query", "HTTPS"),
      e("stream", "consumer", "records", "Kinesis"),
      e("flow", "worker", "task", "states"),
      e("api", "logs"),
      e("logs", "alarms"),
      e("alarms", "sns"),
    ],
    delta: ["multi-AZ managed services"],
    costDrivers: [],
    tradeoffs: ["managed over self-hosted"],
  } as Tier;
}

describe("deterministic Terraform — widened emitter vocabulary (Cognito/SES/StepFns/Kinesis/OpenSearch)", () => {
  const { code, coverage, gaps } = assembleTier(integrationTier(), { region: "us-east-1" });

  it("normalizes each new service to its own key (not 'unsupported')", () => {
    expect(normalizeServiceKey({ awsService: "Amazon Cognito", role: "user pool" })).toBe("cognito");
    expect(normalizeServiceKey({ awsService: "Amazon SES", role: "email" })).toBe("ses");
    expect(normalizeServiceKey({ awsService: "AWS Step Functions", role: "workflow" })).toBe("step-functions");
    expect(normalizeServiceKey({ awsService: "Amazon Kinesis Data Streams", role: "ingest" })).toBe("kinesis");
    expect(normalizeServiceKey({ awsService: "Amazon OpenSearch Service", role: "search" })).toBe("opensearch");
    // Regression: 'ses' must not swallow secrets-manager (matched earlier) or kinesis.
    expect(normalizeServiceKey({ awsService: "AWS Secrets Manager", role: "creds" })).toBe("secrets-manager");
    expect(normalizeServiceKey({ awsService: "Amazon Kinesis", role: "stream" })).toBe("kinesis");
    // Regression: a Step Functions 'scheduler' workflow is NOT the EventBridge Scheduler.
    expect(normalizeServiceKey({ awsService: "AWS Step Functions", role: "nightly scheduler" })).toBe(
      "step-functions",
    );
  });

  it("templates the entire tier with zero wire-up gaps (no LLM fallback)", () => {
    expect(coverage.unsupported).toEqual([]);
    expect(coverage.ratio).toBe(1);
    expect(gaps).toEqual([]);
    expect(detectWireupGaps(code)).toEqual([]);
  });

  it("emits the core resource for each new service", () => {
    expect(code).toContain('resource "aws_cognito_user_pool"');
    expect(code).toContain('resource "aws_cognito_user_pool_client"');
    expect(code).toContain('resource "aws_sesv2_email_identity"');
    expect(code).toContain('resource "aws_sesv2_configuration_set_event_destination"');
    expect(code).toContain('resource "aws_sfn_state_machine"');
    expect(code).toContain('resource "aws_kinesis_stream"');
    expect(code).toContain('resource "aws_opensearch_domain"');
  });

  it("derives least-privilege IAM for each integration from the edges", () => {
    expect(code).toContain("cognito-idp:AdminInitiateAuth");
    expect(code).toContain("ses:SendEmail");
    expect(code).toContain("states:StartExecution");
    expect(code).toContain("kinesis:PutRecord");
    expect(code).toContain("es:ESHttpGet");
  });

  it("wires a kinesis→lambda consumer and a step-functions→lambda task from edges", () => {
    // Consumer event-source mapping + read grant.
    expect(code).toContain('resource "aws_lambda_event_source_mapping"');
    expect(code).toContain("kinesis:GetRecords");
    // The workflow role can invoke its task Lambda, and the definition references it.
    expect(code).toContain("lambda:InvokeFunction");
    expect(code).toContain('Type = "Task"');
  });

  it("places OpenSearch in the VPC with a caller-scoped security group (budget uses the free at-rest key)", () => {
    // OpenSearch is VPC-bound → the tier gets private subnets + NAT.
    expect(code).toContain('resource "aws_subnet" "private_a"');
    expect(code).toContain('resource "aws_nat_gateway"');
    // Its SG admits the VPC-attached API Lambda on 443, and it enforces HTTPS + n2n.
    expect(code).toContain("node_to_node_encryption");
    expect(code).toContain("enforce_https       = true");
    // None-sensitivity budget stays on the FREE at-rest floor — Kinesis uses the
    // AWS-managed key, and OpenSearch omits a customer CMK entirely.
    expect(code).toContain('kms_key_id      = "alias/aws/kinesis"');
    expect(code).not.toContain('resource "aws_kms_key" "main"');
  });

  it("keeps braces/brackets balanced (coarse parse-ability)", () => {
    const count = (s: string, c: string): number => s.split(c).length - 1;
    expect(count(code, "{")).toBe(count(code, "}"));
    expect(count(code, "[")).toBe(count(code, "]"));
    expect(code).not.toContain("undefined");
    expect(code).not.toContain("NaN");
  });

  it("the paid (balanced) tier still templates fully with zero gaps — CMK refs wire cleanly", () => {
    const paid = assembleTier(integrationTier("balanced"), { region: "us-east-1" });
    expect(paid.coverage.unsupported).toEqual([]);
    expect(paid.coverage.ratio).toBe(1);
    expect(paid.gaps).toEqual([]);
    // Kinesis + OpenSearch encrypt with the customer CMK at the paid floor.
    expect(paid.code).toContain("kms_key_id      = aws_kms_key.main.arn");
    expect(paid.code).toContain("kms_key_id = aws_kms_key.main.arn");
  });
});
