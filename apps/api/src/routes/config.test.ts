import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import { stripCodeFence, flagIfIncomplete, detectWireupGaps, annotateWireupGaps } from "./config.js";
import type { LlmProvider, ProviderResult, Usage } from "../llm/provider.js";
import type { ArchitectureResult, Clarification, Tier } from "../schema/architecture.js";

import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import type { TelemetrySink } from "../obs/telemetry.js";

import { buildAppContext, registerApiRoutes, type AppContext } from "../app/context.js";

const USAGE: Usage = { inputTokens: 600, outputTokens: 1200, cacheReadTokens: 2048, cacheWriteTokens: 0 };
const CANNED_HCL = 'resource "aws_lambda_function" "api" {\n  function_name = "api"\n}';

describe("stripCodeFence", () => {
  it("removes a ```hcl fence so the artifact is valid HCL", () => {
    expect(stripCodeFence('```hcl\nresource "x" "y" {}\n```')).toBe('resource "x" "y" {}');
  });
  it("leaves un-fenced HCL untouched", () => {
    expect(stripCodeFence('resource "x" "y" {}')).toBe('resource "x" "y" {}');
  });
  it("drops a dangling opener when the closing fence was truncated", () => {
    expect(stripCodeFence('```hcl\nresource "x" "y" {')).toBe('resource "x" "y" {');
  });
});

describe("flagIfIncomplete", () => {
  it("leaves balanced HCL untouched (incl. interpolation/jsonencode braces)", () => {
    const hcl = 'resource "x" "y" {\n  tags = jsonencode({ name = "${var.p}" })\n}';
    expect(flagIfIncomplete(hcl)).toBe(hcl);
  });
  it("appends an INCOMPLETE marker when braces are unbalanced (truncated mid-resource)", () => {
    const out = flagIfIncomplete('resource "x" "y" {\n  bucket = "a"');
    expect(out).toContain("INCOMPLETE");
    expect(out).toContain("will NOT 'terraform plan'");
  });
});

// --- Wire-up validator fixtures --------------------------------------------
// BROKEN: a compact reference carrying every confirmed blocker — a CMK with no key
// policy (encrypting Logs + SNS), an https-only CF origin on an EC2 public_dns, an
// ACM DNS cert with no validation resource, a null rotation lambda, and a CF
// logging_config bucket with no delivery policy. `terraform plan` stays green on all.
const BROKEN_HCL = [
  'resource "aws_kms_key" "main" {',
  "  enable_key_rotation = true",
  "}",
  'resource "aws_instance" "engine" {',
  '  ami           = "ami-x"',
  '  instance_type = "t4g.small"',
  "}",
  'resource "aws_cloudwatch_log_group" "app" {',
  "  kms_key_id = aws_kms_key.main.arn",
  "}",
  'resource "aws_sns_topic" "alerts" {',
  "  kms_master_key_id = aws_kms_key.main.arn",
  "}",
  'resource "aws_acm_certificate" "cf" {',
  '  domain_name       = "example.com"',
  '  validation_method = "DNS"',
  "}",
  'resource "aws_cloudfront_distribution" "main" {',
  "  origin {",
  "    domain_name = aws_instance.engine.public_dns",
  "    custom_origin_config {",
  '      origin_protocol_policy = "https-only"',
  "    }",
  "  }",
  "  logging_config {",
  "    bucket = aws_s3_bucket.cf_logs.id",
  "  }",
  "}",
  'resource "aws_secretsmanager_secret_rotation" "app" {',
  "  secret_id           = aws_secretsmanager_secret.app.id",
  "  rotation_lambda_arn = null",
  "}",
].join("\n");

// CLEAN: the same shape with the wire-up present — CMK key policy grants the Logs +
// CloudWatch service principals, an ACM validation resource, an ALB origin (not an
// EC2 public_dns), a log-delivery bucket policy, and no placeholder rotation.
const CLEAN_HCL = [
  'data "aws_iam_policy_document" "kms_main" {',
  "  statement {",
  "    principals {",
  '      type        = "Service"',
  '      identifiers = ["logs.us-east-1.amazonaws.com", "cloudwatch.amazonaws.com"]',
  "    }",
  "  }",
  "}",
  'resource "aws_kms_key" "main" {',
  "  enable_key_rotation = true",
  "  policy              = data.aws_iam_policy_document.kms_main.json",
  "}",
  'resource "aws_cloudwatch_log_group" "app" {',
  "  kms_key_id = aws_kms_key.main.arn",
  "}",
  'resource "aws_sns_topic" "alerts" {',
  "  kms_master_key_id = aws_kms_key.main.arn",
  "}",
  'resource "aws_acm_certificate" "cf" {',
  '  domain_name       = "example.com"',
  '  validation_method = "DNS"',
  "}",
  'resource "aws_acm_certificate_validation" "cf" {',
  "  certificate_arn = aws_acm_certificate.cf.arn",
  "}",
  'resource "aws_cloudfront_distribution" "main" {',
  "  origin {",
  "    domain_name = aws_lb.app.dns_name",
  "    custom_origin_config {",
  '      origin_protocol_policy = "https-only"',
  "    }",
  "  }",
  "  logging_config {",
  "    bucket = aws_s3_bucket.cf_logs.id",
  "  }",
  "}",
  'data "aws_cloudfront_log_delivery_canonical_user_ids" "cf_logs" {}',
  'resource "aws_s3_bucket_policy" "cf_logs" {',
  "  bucket = aws_s3_bucket.cf_logs.id",
  "}",
].join("\n");

describe("detectWireupGaps", () => {
  it("flags every blocker in a broken reference", () => {
    const ids = detectWireupGaps(BROKEN_HCL).map((g) => g.id);
    expect(ids).toContain("kms-key-policy");
    expect(ids).toContain("cloudfront-origin-tls");
    expect(ids).toContain("acm-certificate-validation");
    expect(ids).toContain("secretsmanager-rotation-lambda");
    expect(ids).toContain("s3-access-log-delivery");
  });
  it("returns no gaps for a wired-up reference", () => {
    expect(detectWireupGaps(CLEAN_HCL)).toEqual([]);
  });
});

describe("annotateWireupGaps", () => {
  it("leaves clean HCL untouched", () => {
    expect(annotateWireupGaps(CLEAN_HCL)).toBe(CLEAN_HCL);
  });
  it("appends a WIRE-UP GAPS banner citing each rule id as valid `#` comments", () => {
    const out = annotateWireupGaps(BROKEN_HCL);
    expect(out).toContain("WIRE-UP GAPS");
    expect(out).toContain("[kms-key-policy]");
    expect(out).toContain("[acm-certificate-validation]");
    // The banner is plain `#` comments so it survives `terraform plan`.
    expect(out.split("\n").filter((l) => l.startsWith("#")).length).toBeGreaterThan(0);
    // The original HCL body is preserved above the banner.
    expect(out.startsWith(BROKEN_HCL)).toBe(true);
  });
});

// --- Canned tier ------------------------------------------------------------

// A tier built from services with NO deterministic emitter (MSK + Neptune), so it
// always routes to the LLM fallback — used to exercise the LLM path's spend/cache/error
// behavior. (Cognito, Kinesis, API Gateway, DynamoDB are now templated, hence not used
// here — pick services still outside the emitter vocabulary to force the fallback.)
function balancedTier(): Tier {
  return {
    name: "balanced",
    summary: "balanced tier",
    nodes: [
      {
        id: "kafka",
        awsService: "Amazon MSK (Managed Streaming for Apache Kafka)",
        role: "event backbone",
        security: ["encryption at rest", "least-priv role"],
      },
      {
        id: "graphdb",
        awsService: "Amazon Neptune",
        role: "graph store",
        security: ["private subnet", "least-priv role"],
      },
    ],
    edges: [
      { from: "client", to: "kafka", payload: "event record", protocol: "TLS" },
      { from: "kafka", to: "graphdb", payload: "graph write", protocol: "Bolt" },
    ],
    costDrivers: [{ service: "Amazon MSK", unit: "per broker-hour", estimateRange: "$0.00–$0.55", note: "" }],
    delta: ["+ multi-AZ"],
    tradeoffs: ["vs resilient: cheaper, single-region"],
  };
}

// A FULLY-TEMPLATED tier (every service has a deterministic emitter) — used to
// exercise the $0/instant deterministic path. `balancedTier` (MSK + Neptune) has no
// emitters, so that tier still routes to the LLM fallback.
function templatedTier(): Tier {
  return {
    name: "budget",
    summary: "templated single-box-ish",
    nodes: [
      { id: "store", awsService: "S3", role: "asset store", security: ["SSE-KMS", "block public access"] },
      { id: "fn", awsService: "Lambda", role: "api worker", security: ["least-priv role"] },
      { id: "secrets", awsService: "AWS Secrets Manager", role: "credentials store", security: ["KMS-encrypted"] },
    ],
    edges: [
      { from: "fn", to: "store", payload: "object read/write", protocol: "HTTPS" },
      { from: "fn", to: "secrets", payload: "db creds", protocol: "HTTPS" },
    ],
    costDrivers: [],
    delta: ["baseline"],
    tradeoffs: ["cheapest correct"],
  };
}

// --- Fake provider (no network) ---------------------------------------------

interface FakeOpts {
  configError?: boolean;
}

interface Fake {
  provider: LlmProvider;
  calls: { generateConfig: number };
}

function makeFake(opts: FakeOpts = {}): Fake {
  const calls = { generateConfig: 0 };
  const provider: LlmProvider = {
    async clarify(): Promise<ProviderResult<Clarification>> {
      return { result: { needsClarification: false, questions: [] }, usage: USAGE };
    },
    async generate(): Promise<ProviderResult<ArchitectureResult>> {
      throw new Error("generate not used in config tests");
    },
    async generateConfig(): Promise<ProviderResult<string>> {
      calls.generateConfig += 1;
      if (opts.configError) throw new Error("upstream boom");
      return { result: CANNED_HCL, usage: USAGE };
    },
    async countTokens(text: string): Promise<number> {
      return text.length;
    },
  };
  return { provider, calls };
}

function testConfig(overrides: Record<string, string> = {}): ReturnType<typeof loadConfig> {
  return loadConfig({ ANTHROPIC_API_KEY: "test-key", NODE_ENV: "test", DB_PATH: ":memory:", ...overrides });
}

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  stores: Stores;
  lines: string[];
}

async function buildHarness(fake: Fake, configOverrides: Record<string, string> = {}): Promise<Harness> {
  const stores = createStores(openTempDb());
  const lines: string[] = [];
  const sink: TelemetrySink = (line) => lines.push(line);
  const ctx = await buildAppContext(testConfig(configOverrides), {
    provider: fake.provider,
    stores,
    telemetrySink: sink,
  });
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApiRoutes(app, ctx);
  return { app, ctx, stores, lines };
}

function lastTelemetry(lines: string[]): Record<string, unknown> {
  const line = lines.at(-1);
  expect(line).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

describe("POST /api/config", () => {
  it("happy path returns { format:'terraform', code } and emits one telemetry line", async () => {
    const fake = makeFake();
    const { app, lines } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("terraform");
    // The generated HCL is prepended with a reference-only warning header (before line 1).
    expect(body.code).toContain(CANNED_HCL);
    expect(body.code).toMatch(/^#+\n# ⚠ {2}REFERENCE ONLY/);
    expect(fake.calls.generateConfig).toBe(1);

    const rec = lastTelemetry(lines);
    expect(lines).toHaveLength(1);
    expect(rec.route).toBe("/api/config");
    expect(rec.cacheHit).toBe(false);
    expect(rec.outcome).toBe("ok");
    expect(rec.costUsd as number).toBeGreaterThan(0);

    await app.close();
  });

  it("identical tier is served from cache: no second provider call, costUsd 0, spend untouched", async () => {
    const fake = makeFake();
    const { app, ctx, lines } = await buildHarness(fake);

    const first = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(first.statusCode).toBe(200);
    expect(fake.calls.generateConfig).toBe(1);
    const spendAfterFirst = await ctx.stores.spendLedger.spentTodayUsd();

    const second = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // The provider was NOT called again — the cache short-circuited generation.
    expect(fake.calls.generateConfig).toBe(1);
    // A cache hit consumes no spend (KTD8).
    expect(await ctx.stores.spendLedger.spentTodayUsd()).toBeCloseTo(spendAfterFirst);

    const rec = lastTelemetry(lines);
    expect(rec.cacheHit).toBe(true);
    expect(rec.costUsd).toBe(0);

    await app.close();
  });

  it("rate-limit: the over-window request is 429", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { RATE_LIMIT_MAX: "1" });

    const ok = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(ok.statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("rate_limited");

    await app.close();
  });

  it("global ceiling: a config call is refused 503 when the budget is exhausted", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { DAILY_SPEND_CEILING_USD: "0.0001" });

    const res = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("daily_budget_reached");
    expect(fake.calls.generateConfig).toBe(0);

    await app.close();
  });

  it("invalid body (missing tier) is a 400", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/config", payload: { description: "no tier" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/tier/i);
    expect(fake.calls.generateConfig).toBe(0);

    await app.close();
  });

  it("generation error releases the reservation and returns 502", async () => {
    const fake = makeFake({ configError: true });
    const { app, ctx, lines } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("config_generation_failed");
    expect(await ctx.stores.spendLedger.spentTodayUsd()).toBeCloseTo(0);
    expect(lastTelemetry(lines).outcome).toBe("error");

    await app.close();
  });
});

describe("POST /api/config — deterministic Terraform (TERRAFORM_DETERMINISTIC)", () => {
  it("renders a fully-templated tier with NO LLM call, $0 spend, and the deterministic banner", async () => {
    const fake = makeFake();
    const { app, ctx, lines } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/config", payload: { tier: templatedTier() } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("terraform");
    // The deterministic banner identifies the path; the reference warning still leads.
    expect(body.code).toContain("DETERMINISTICALLY");
    expect(body.code).toMatch(/^#+\n# ⚠ {2}REFERENCE ONLY/);
    // The typed graph was rendered directly — the provider was never called.
    expect(fake.calls.generateConfig).toBe(0);
    // And no spend was reserved/consumed (it's a $0 path).
    expect(await ctx.stores.spendLedger.spentTodayUsd()).toBeCloseTo(0);

    const rec = lastTelemetry(lines);
    expect(rec.outcome).toBe("ok");
    expect(rec.cacheHit).toBe(false);
    expect(rec.costUsd).toBe(0);

    await app.close();
  });

  it("forcing TERRAFORM_DETERMINISTIC=false routes the same templated tier to the LLM path", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { TERRAFORM_DETERMINISTIC: "false" });

    const res = await app.inject({ method: "POST", url: "/api/config", payload: { tier: templatedTier() } });
    expect(res.statusCode).toBe(200);
    expect(fake.calls.generateConfig).toBe(1);

    await app.close();
  });

  it("a tier with an unsupported service (MSK + Neptune) falls back to the LLM long tail", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(res.statusCode).toBe(200);
    expect(fake.calls.generateConfig).toBe(1);

    await app.close();
  });
});
