import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { buildAppContext, registerApiRoutes } from "../app/context.js";

function testConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    ANTHROPIC_API_KEY: "test-key",
    NODE_ENV: "test",
    DB_PATH: ":memory:",
    SITE_ORIGIN: "https://example.com",
  });
}

const DESIGN = JSON.stringify({ recommendedTier: "balanced", tiers: [], assumptions: [] });

async function buildHarness(): Promise<{ app: FastifyInstance; stores: Stores }> {
  const stores = createStores(openTempDb());
  const ctx = await buildAppContext(testConfig(), { stores });
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApiRoutes(app, ctx);
  return { app, stores };
}

describe("SEO routes", () => {
  it("GET /robots.txt allows the SPA, disallows /api/, links the sitemap at SITE_ORIGIN", async () => {
    const { app } = await buildHarness();
    const res = await app.inject({ method: "GET", url: "/robots.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("Allow: /");
    expect(res.body).toContain("Disallow: /api/");
    expect(res.body).toContain("Sitemap: https://example.com/sitemap.xml");
    await app.close();
  });

  it("GET /sitemap.xml lists landing + gallery + curated + approved designs (not pending)", async () => {
    const { app, stores } = await buildHarness();

    await stores.curated.upsert({ id: "curated-slug", title: "Chat app", prompt: "p", body: DESIGN });

    const approved = await stores.generations.upsert({
      promptHash: "h-approve",
      description: "a",
      answers: [],
      model: "claude-sonnet-4-6",
      region: "us-east-1",
      recommendedTier: "balanced",
      tags: [],
      body: DESIGN,
      clientIp: "1.1.1.1",
    });
    await stores.generations.setStatus(approved.id, "approved");

    const pending = await stores.generations.upsert({
      promptHash: "h-pending",
      description: "p",
      answers: [],
      model: "claude-sonnet-4-6",
      region: "us-east-1",
      recommendedTier: "balanced",
      tags: [],
      body: DESIGN,
      clientIp: "1.1.1.1",
    });
    // pending left in its default (non-public) status.

    const res = await app.inject({ method: "GET", url: "/sitemap.xml" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.body).toContain("<?xml");
    expect(res.body).toContain("https://example.com/");
    expect(res.body).toContain("https://example.com/gallery");
    expect(res.body).toContain(`https://example.com/design/curated-slug`);
    expect(res.body).toContain(`https://example.com/design/${approved.id}`);
    // A pending design is not publicly reachable → must not be advertised.
    expect(res.body).not.toContain(pending.id);
    await app.close();
  });
});
