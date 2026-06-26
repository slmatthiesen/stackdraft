import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import type { LlmProvider, ProviderResult, Usage } from "../llm/provider.js";
import type { ArchitectureResult, Clarification, Tier } from "../schema/architecture.js";

import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import type { TelemetrySink } from "../obs/telemetry.js";

import { buildAppContext, registerApiRoutes, type AppContext } from "../app/context.js";

const USAGE: Usage = { inputTokens: 600, outputTokens: 1200, cacheReadTokens: 2048, cacheWriteTokens: 0 };
const CANNED_HCL = 'resource "aws_lambda_function" "api" {\n  function_name = "api"\n}';

// --- Canned tier ------------------------------------------------------------

function balancedTier(): Tier {
  return {
    name: "balanced",
    summary: "balanced tier",
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
    delta: ["+ multi-AZ"],
    tradeoffs: ["vs resilient: cheaper, single-region"],
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
  const ctx = buildAppContext(testConfig(configOverrides), {
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
    expect(body.code).toBe(CANNED_HCL);
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
    const spendAfterFirst = ctx.stores.spendLedger.spentTodayUsd();

    const second = await app.inject({ method: "POST", url: "/api/config", payload: { tier: balancedTier() } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // The provider was NOT called again — the cache short-circuited generation.
    expect(fake.calls.generateConfig).toBe(1);
    // A cache hit consumes no spend (KTD8).
    expect(ctx.stores.spendLedger.spentTodayUsd()).toBeCloseTo(spendAfterFirst);

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
    expect(ctx.stores.spendLedger.spentTodayUsd()).toBeCloseTo(0);
    expect(lastTelemetry(lines).outcome).toBe("error");

    await app.close();
  });
});
