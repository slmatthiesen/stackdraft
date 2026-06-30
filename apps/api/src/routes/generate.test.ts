import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import type { LlmProvider, ProviderResult, Usage } from "../llm/provider.js";
import type { EmbeddingProvider } from "../llm/embeddings/provider.js";
import type { ArchitectureResult, Clarification, TierName } from "../schema/architecture.js";
import { TIER_NAMES } from "../schema/architecture.js";

import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import type { TelemetrySink } from "../obs/telemetry.js";

import { buildAppContext, registerApiRoutes, type AppContext } from "../app/context.js";

const USAGE: Usage = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 4096, cacheWriteTokens: 0 };

// --- Canned schema-valid architecture ---------------------------------------

function makeTier(name: TierName): ArchitectureResult["tiers"][number] {
  return {
    name,
    summary: `${name} tier`,
    nodes: [
      {
        id: "api",
        awsService: "API Gateway",
        role: "front door",
        security: ["TLS", "WAF", "throttling", "least-priv role"],
      },
      {
        id: "db",
        awsService: "DynamoDB",
        role: "primary datastore",
        security: ["encryption at rest", "on-demand", "least-priv role"],
      },
    ],
    edges: [
      { from: "client", to: "api", payload: "JSON request body", protocol: "HTTPS" },
      { from: "api", to: "db", payload: "item read/write", protocol: "HTTPS" },
    ],
    costDrivers: [{ service: "API Gateway", unit: "per 1k requests", estimateRange: "$0.20–$0.90", note: "" }],
    delta: name === "budget" ? ["baseline: single-AZ, on-demand"] : ["+ multi-AZ"],
    tradeoffs: ["vs balanced: cheaper, single-AZ"],
  };
}

function validArchitecture(): ArchitectureResult {
  return {
    assumptions: ["single region us-east-1"],
    clarificationsUsed: [],
    securityFloor: [
      "Encryption at rest with KMS / SSE.",
      "TLS in transit; HTTPS only.",
      "Least-privilege IAM, no long-lived keys.",
      "S3 Block Public Access on.",
      "Data tier in private subnets.",
      "Secrets in AWS Secrets Manager.",
      "Edge protection: CloudFront + WAF.",
      "CloudTrail + access logging.",
    ],
    tiers: TIER_NAMES.map(makeTier),
    recommendedTier: "balanced",
    recommendationRationale: "Balanced fits moderate, bursty traffic with multi-AZ availability.",
    keyDecisions: [
      {
        decision: "Compute model",
        chosen: "Lambda behind API Gateway",
        alternativesConsidered: ["Fargate"],
        rationale: "Serverless scales to zero and removes capacity management.",
      },
    ],
  };
}

// --- Fake provider (no network) ---------------------------------------------

interface FakeOpts {
  needsClarification?: boolean;
  questions?: string[];
  arch?: ArchitectureResult;
  generateError?: boolean;
}

interface Fake {
  provider: LlmProvider;
  calls: { generate: number; clarify: number };
}

function makeFake(opts: FakeOpts = {}): Fake {
  const calls = { generate: 0, clarify: 0 };
  const provider: LlmProvider = {
    async clarify(): Promise<ProviderResult<Clarification>> {
      calls.clarify += 1;
      return {
        result: { needsClarification: opts.needsClarification ?? false, questions: opts.questions ?? [] },
        usage: USAGE,
      };
    },
    async generate(): Promise<ProviderResult<ArchitectureResult>> {
      calls.generate += 1;
      if (opts.generateError) throw new Error("upstream boom");
      return { result: opts.arch ?? validArchitecture(), usage: USAGE };
    },
    async generateConfig(): Promise<ProviderResult<string>> {
      return { result: 'resource "aws_lambda_function" "api" {}', usage: USAGE };
    },
    async countTokens(text: string): Promise<number> {
      return text.length;
    },
  };
  return { provider, calls };
}

function testConfig(overrides: Record<string, string> = {}): ReturnType<typeof loadConfig> {
  // Retrieval OFF by default in tests (no Voyage key, no network); the learning-network
  // tests inject a fake embedder explicitly.
  return loadConfig({ ANTHROPIC_API_KEY: "test-key", NODE_ENV: "test", DB_PATH: ":memory:", EMBEDDING_PROVIDER: "none", ...overrides });
}

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  stores: Stores;
  lines: string[];
}

async function buildHarness(
  fake: Fake,
  configOverrides: Record<string, string> = {},
  extra: { embedder?: EmbeddingProvider | null } = {},
): Promise<Harness> {
  const stores = createStores(openTempDb());
  const lines: string[] = [];
  const sink: TelemetrySink = (line) => lines.push(line);
  const ctx = buildAppContext(testConfig(configOverrides), {
    provider: fake.provider,
    stores,
    telemetrySink: sink,
    ...("embedder" in extra ? { embedder: extra.embedder } : {}),
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

const SPEC = "A serverless REST API on Lambda + DynamoDB for a small SaaS; bursty but low volume.";

describe("POST /api/generate", () => {
  it("happy path returns three tiers + costs and emits one telemetry line (R3)", async () => {
    const fake = makeFake();
    const { app, lines } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tiers.map((t: { name: string }) => t.name)).toEqual(["budget", "balanced", "resilient"]);
    expect(Array.isArray(body.assumptions)).toBe(true);
    // Staff-level signal is surfaced alongside the tiers.
    expect(body.recommendedTier).toBe("balanced");
    expect(typeof body.recommendationRationale).toBe("string");
    // The global security floor must survive into the response (a cherry-picking
    // response body dropped it after the schema added it).
    expect(Array.isArray(body.securityFloor)).toBe(true);
    expect(body.securityFloor.length).toBeGreaterThan(0);
    expect(body.keyDecisions[0].chosen).toBe("Lambda behind API Gateway");
    expect(body.assumptions.some((a: string) => /on-demand list prices/i.test(a))).toBe(true);
    // Cost drivers were filled deterministically (U7), not left as the canned stub only.
    expect(body.tiers[0].costDrivers.length).toBeGreaterThan(0);
    expect(fake.calls.generate).toBe(1);

    const rec = lastTelemetry(lines);
    expect(lines).toHaveLength(1);
    expect(rec.kind).toBe("request_telemetry");
    expect(rec.route).toBe("/api/generate");
    expect(rec.cacheHit).toBe(false);
    expect(rec.outcome).toBe("ok");
    expect(rec.costUsd as number).toBeGreaterThan(0);

    await app.close();
  });

  it("serves an instant hit from the learning network — no LLM, no clarify, $0, deep-linkable", async () => {
    const fake = makeFake();
    const PROMPT = "a notification fan-out service with retries and a DLQ";
    // A fake embedder that maps every text to the same vector → cosine 1 with the seeded design.
    const embedder: EmbeddingProvider = { model: "voyage-3-lite", embed: async (texts) => texts.map(() => [1, 0, 0]) };
    const { app, stores, lines } = await buildHarness(fake, {}, { embedder });

    // Seed one APPROVED design + its embedding into the corpus.
    const { id } = stores.generations.upsert({
      promptHash: "ph-notif",
      description: PROMPT,
      answers: [],
      model: "claude-sonnet-4-6",
      region: "us-east-1",
      recommendedTier: "balanced",
      tags: ["messaging"],
      body: JSON.stringify(validArchitecture()),
      clientIp: "9.9.9.9",
    });
    stores.generations.setStatus(id, "approved");
    stores.designVectors.upsert({ id, source: "generation", promptHash: "ph-notif", text: PROMPT, vector: [1, 0, 0], model: "voyage-3-lite" });

    const res = await app.inject({ method: "POST", url: "/api/generate", payload: { description: PROMPT } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id); // deep-linkable to the existing /design/:id
    expect(body.fromLibrary).toBeDefined();
    expect(body.fromLibrary.basedOnPrompt).toBe(PROMPT);
    expect(body.fromLibrary.similarity).toBeCloseTo(1, 2);
    expect(body.tiers).toHaveLength(3);
    // No model work at all — instant serve short-circuits before clarify AND generate.
    expect(fake.calls.generate).toBe(0);
    expect(fake.calls.clarify).toBe(0);

    const rec = lastTelemetry(lines);
    expect(rec.outcome).toBe("library");
    expect(rec.cacheHit).toBe(true);
    expect(rec.costUsd).toBe(0);

    await app.close();
  });

  it("round 1 ambiguous returns questions; round 2 forces generation (R2)", async () => {
    const fake = makeFake({ needsClarification: true, questions: ["What traffic shape?"] });
    const { app } = await buildHarness(fake);

    const round1 = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: { description: "build me something", round: 1 },
    });
    expect(round1.statusCode).toBe(200);
    expect(round1.json().needsClarification).toBe(true);
    expect(round1.json().questions).toEqual(["What traffic shape?"]);
    expect(fake.calls.generate).toBe(0);

    const round2 = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: { description: "build me something", round: 2 },
    });
    expect(round2.statusCode).toBe(200);
    expect(round2.json().tiers).toHaveLength(3);
    expect(fake.calls.generate).toBe(1);

    await app.close();
  });

  it("invalid body is a 400 with a clear validation message", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/generate", payload: { answers: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/description/i);
    expect(fake.calls.generate).toBe(0);

    await app.close();
  });

  it("rate-limit: the over-window request is 429 (R11)", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { RATE_LIMIT_MAX: "1" });

    const ok = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(ok.statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("rate_limited");

    await app.close();
  });

  it("per-IP daily cap: a second generation from the same IP is 429 (R11)", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { PER_IP_DAILY_GENERATIONS: "1" });

    const first = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(first.statusCode).toBe(200);
    // Different prompt so it is a cache MISS that must consult the cap (not a cache hit).
    const second = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: { description: `${SPEC} with search` },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe("daily_cap_reached");

    await app.close();
  });

  it("global ceiling: generation is refused 503 when the budget is exhausted (R11)", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { DAILY_SPEND_CEILING_USD: "0.0001" });

    const res = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("daily_budget_reached");
    expect(fake.calls.generate).toBe(0);

    await app.close();
  });

  it("Turnstile enabled: a request with no token is 403 (R11)", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { TURNSTILE_SECRET: "secret" });

    const res = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("turnstile_required");

    await app.close();
  });

  it("access gate enabled: a request without basic-auth is 401 (R11)", async () => {
    const fake = makeFake();
    const { app } = await buildHarness(fake, { ACCESS_GATE_USER: "demo", ACCESS_GATE_PASS: "pw" });

    const res = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("identical prompt is served from cache: no second generate call, costUsd 0, cap+spend untouched (R11)", async () => {
    const fake = makeFake();
    const { app, ctx, lines } = await buildHarness(fake);

    const first = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(first.statusCode).toBe(200);
    expect(fake.calls.generate).toBe(1);
    const spendAfterFirst = ctx.stores.spendLedger.spentTodayUsd();
    const capAfterFirst = ctx.stores.spendLedger.ipCountToday("127.0.0.1");
    expect(capAfterFirst).toBe(1);

    const second = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // The provider was NOT called again — the cache short-circuited generation.
    expect(fake.calls.generate).toBe(1);
    // A cache hit consumes neither the per-IP cap nor the spend ledger (KTD8).
    expect(ctx.stores.spendLedger.ipCountToday("127.0.0.1")).toBe(1);
    expect(ctx.stores.spendLedger.spentTodayUsd()).toBeCloseTo(spendAfterFirst);

    const rec = lastTelemetry(lines);
    expect(rec.cacheHit).toBe(true);
    expect(rec.costUsd).toBe(0);

    await app.close();
  });

  it("generation error releases the reservation and returns 502", async () => {
    const fake = makeFake({ generateError: true });
    const { app, ctx, lines } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/generate", payload: { description: SPEC } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("generation_failed");
    // The reservation was released — no spend lingers from a call that produced nothing.
    expect(ctx.stores.spendLedger.spentTodayUsd()).toBeCloseTo(0);
    expect(lastTelemetry(lines).outcome).toBe("error");

    await app.close();
  });
});
