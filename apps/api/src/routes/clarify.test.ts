import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import type { LlmProvider, ProviderResult, Usage } from "../llm/provider.js";
import type { Clarification, ArchitectureResult } from "../schema/architecture.js";

import { openTempDb, createStores } from "../store/sqlite.js";
import type { TelemetrySink } from "../obs/telemetry.js";

import { buildAppContext, registerApiRoutes } from "../app/context.js";

const USAGE: Usage = { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 };

interface Fake {
  provider: LlmProvider;
  calls: { generate: number; clarify: number };
}

function makeFake(needsClarification: boolean, questions: string[] = []): Fake {
  const calls = { generate: 0, clarify: 0 };
  const provider: LlmProvider = {
    async clarify(): Promise<ProviderResult<Clarification>> {
      calls.clarify += 1;
      return { result: { needsClarification, questions }, usage: USAGE };
    },
    async generate(): Promise<ProviderResult<ArchitectureResult>> {
      calls.generate += 1;
      throw new Error("clarify route must never generate");
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

async function buildHarness(fake: Fake, configOverrides: Record<string, string> = {}): Promise<{ app: FastifyInstance; lines: string[] }> {
  const stores = createStores(openTempDb());
  const lines: string[] = [];
  const sink: TelemetrySink = (line) => lines.push(line);
  const ctx = buildAppContext(testConfig(configOverrides), { provider: fake.provider, stores, telemetrySink: sink });
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApiRoutes(app, ctx);
  return { app, lines };
}

describe("POST /api/clarify", () => {
  it("returns questions for an ambiguous prompt and emits telemetry (R2)", async () => {
    const fake = makeFake(true, ["What is the expected traffic?"]);
    const { app, lines } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/clarify", payload: { description: "build me a thing" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().needsClarification).toBe(true);
    expect(res.json().questions).toEqual(["What is the expected traffic?"]);
    expect(fake.calls.generate).toBe(0);

    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(rec.route).toBe("/api/clarify");
    expect(rec.outcome).toBe("clarify");

    await app.close();
  });

  it("returns needsClarification=false for a fully specified prompt", async () => {
    const fake = makeFake(false);
    const { app } = await buildHarness(fake);

    const res = await app.inject({
      method: "POST",
      url: "/api/clarify",
      payload: { description: "A serverless REST API on Lambda + DynamoDB", answers: ["low volume"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().needsClarification).toBe(false);
    expect(res.json().questions).toEqual([]);

    await app.close();
  });

  it("invalid body is a 400", async () => {
    const fake = makeFake(false);
    const { app } = await buildHarness(fake);

    const res = await app.inject({ method: "POST", url: "/api/clarify", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(fake.calls.clarify).toBe(0);

    await app.close();
  });

  it("rate-limit applies to clarify too (429)", async () => {
    const fake = makeFake(false);
    const { app } = await buildHarness(fake, { RATE_LIMIT_MAX: "1" });

    const ok = await app.inject({ method: "POST", url: "/api/clarify", payload: { description: "x" } });
    expect(ok.statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/api/clarify", payload: { description: "x" } });
    expect(limited.statusCode).toBe(429);

    await app.close();
  });

  it("access gate guards clarify (401 without creds)", async () => {
    const fake = makeFake(false);
    const { app } = await buildHarness(fake, { ACCESS_GATE_USER: "demo", ACCESS_GATE_PASS: "pw" });

    const res = await app.inject({ method: "POST", url: "/api/clarify", payload: { description: "x" } });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
