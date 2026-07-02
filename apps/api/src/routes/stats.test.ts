import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { utcDayKey } from "../store/clock.js";
import { buildAppContext, registerApiRoutes } from "../app/context.js";

function testConfig(overrides: Record<string, string | undefined> = {}): ReturnType<typeof loadConfig> {
  return loadConfig({
    ANTHROPIC_API_KEY: "test-key",
    NODE_ENV: "test",
    DB_PATH: ":memory:",
    ...overrides,
  });
}

async function buildHarness(overrides: Record<string, string | undefined> = {}): Promise<{
  app: FastifyInstance;
  stores: Stores;
}> {
  const stores = createStores(openTempDb());
  const ctx = await buildAppContext(testConfig(overrides), { stores });
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApiRoutes(app, ctx);
  return { app, stores };
}

const genInput = (promptHash: string, clientIp: string) => ({
  promptHash,
  description: "build a chat app",
  answers: [] as string[],
  model: "claude-sonnet-4-6",
  region: "us-east-1",
  recommendedTier: "balanced",
  tags: ["messaging"],
  body: JSON.stringify({ recommendedTier: "balanced", tiers: [], assumptions: [] }),
  clientIp,
});

const fbInput = (promptHash: string, ip: string, rating: 1 | -1) => ({
  promptHash,
  description: "build a chat app",
  answers: [] as string[],
  round: 0,
  recommendedTier: "balanced",
  body: null,
  rating,
  ip,
  comment: null,
});

describe("GET /api/stats", () => {
  it("404s when STATS_TOKEN is unset (off unless configured — forker-safe)", async () => {
    const { app } = await buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("401s without a token, 401s with the wrong token", async () => {
    const { app } = await buildHarness({ STATS_TOKEN: "secret-token" });
    expect((await app.inject({ method: "GET", url: "/api/stats" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/stats", headers: { authorization: "Bearer nope" } }))
        .statusCode,
    ).toBe(401);
    await app.close();
  });

  it("returns aggregate counts (never raw IPs) with a valid bearer token", async () => {
    const { app, stores } = await buildHarness({ STATS_TOKEN: "secret-token" });

    const a = await stores.generations.upsert(genInput("h-a", "1.1.1.1"));
    const b = await stores.generations.upsert(genInput("h-b", "2.2.2.2"));
    const c = await stores.generations.upsert(genInput("h-c", "1.1.1.1")); // same IP as a
    await stores.generations.setStatus(a.id, "approved");
    await stores.generations.setStatus(c.id, "hidden");
    // b stays pending.

    await stores.feedback.upsert(fbInput("f-1", "9.9.9.9", 1));
    await stores.feedback.upsert(fbInput("f-2", "8.8.8.8", -1));
    await stores.feedback.upsert(fbInput("f-3", "9.9.9.9", 1)); // second up, distinct promptHash

    const res = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const today = utcDayKey(Date.now());

    expect(body.generations).toEqual({
      total: 3,
      byStatus: { pending: 1, approved: 1, hidden: 1 },
      byDay: { [today]: 3 },
      uniqueIpsByDay: { [today]: 2 },
    });
    expect(body.feedback).toEqual({
      total: 3,
      up: 2,
      down: 1,
      byDay: { [today]: { up: 2, down: 1 } },
    });
    // No raw IP strings leak into the report.
    expect(res.body).not.toContain("1.1.1.1");
    expect(res.body).not.toContain("9.9.9.9");
    await app.close();
  });

  it("accepts ?token= for a quick browser visit", async () => {
    const { app } = await buildHarness({ STATS_TOKEN: "secret-token" });
    const res = await app.inject({ method: "GET", url: "/api/stats?token=secret-token" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
