/**
 * DynamoDB conformance tests for the simpler stores (memory, responseCache, pricing,
 * feedback, designVectors). Mirrors the SQLite behavioral expectations against the real
 * emulator so the DynamoDB impls are proven to match the contract — not just typecheck.
 *
 * Run with `pnpm test:dynamo` (needs DynamoDB Local; the vitest.dynamo globalSetup
 * brings it up via Docker). The harder concurrency semantics (spend ceiling, vote dedup)
 * live in concurrency.dynamo.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

import type { Clock } from "../clock.js";
import { makeTestDeps, ensureTables, clearTables } from "./testHarness.js";
import { deleteTables } from "./schema.js";
import { DynamoMemoryStore } from "./memory.js";
import { DynamoResponseCache } from "./responseCache.js";
import { DynamoPricingStore } from "./pricing.js";
import { DynamoFeedbackStore } from "./feedback.js";
import { DynamoDesignVectorStore } from "./designVectors.js";
import type { PriceRecord } from "../types.js";

const deps = makeTestDeps("conf_");

function makeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

beforeAll(async () => {
  await ensureTables(deps);
}, 90_000);

afterAll(async () => {
  await deleteTables(deps);
});

describe("DynamoMemoryStore", () => {
  let store: DynamoMemoryStore;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(async () => {
    await clearTables(deps, ["memory"]);
    clock = makeClock(1_000);
    store = new DynamoMemoryStore(deps, clock);
  });

  const doc = (id: string, topic: string) => ({
    id,
    topic,
    fact: `fact ${id}`,
    rationale: "r",
    source: "https://example.com",
    verified: true,
    provenance: "seed" as const,
  });

  it("upsert then getById returns the stored doc", async () => {
    const saved = await store.upsert(doc("a", "security:x"));
    expect(saved.createdAt).toBe(1_000);
    const got = await store.getById("a");
    expect(got?.fact).toBe("fact a");
  });

  it("upsert preserves createdAt across overwrites, bumps updatedAt", async () => {
    await store.upsert(doc("a", "t"));
    clock.advance(500);
    const updated = await store.upsert({ ...doc("a", "t"), fact: "new" });
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(1_500);
    expect(updated.fact).toBe("new");
  });

  it("get(topic) returns the most-recently-updated doc for the topic", async () => {
    await store.upsert(doc("a", "topic1"));
    clock.advance(10);
    await store.upsert(doc("b", "topic1"));
    const got = await store.get("topic1");
    expect(got?.id).toBe("b");
  });

  it("search returns docs across the given topics, newest first", async () => {
    await store.upsert(doc("a", "t1"));
    clock.advance(10);
    await store.upsert(doc("b", "t2"));
    const hits = await store.search(["t1", "t2"]);
    expect(hits.map((d) => d.id)).toEqual(["b", "a"]);
    expect(await store.search([])).toEqual([]);
  });

  it("listPending returns only unverified docs, oldest first", async () => {
    await store.upsert({ ...doc("v", "t"), verified: true });
    clock.advance(10);
    await store.upsert({ ...doc("p1", "t"), verified: false });
    clock.advance(10);
    await store.upsert({ ...doc("p2", "t"), verified: false });
    const pending = await store.listPending();
    expect(pending.map((d) => d.id)).toEqual(["p1", "p2"]);
  });

  it("setVerified flips the flag; returns false for an unknown id", async () => {
    await store.upsert({ ...doc("a", "t"), verified: false });
    expect(await store.setVerified("a", true)).toBe(true);
    expect((await store.getById("a"))?.verified).toBe(true);
    expect(await store.setVerified("missing", true)).toBe(false);
  });

  it("delete removes a doc; returns false for an unknown id", async () => {
    await store.upsert(doc("a", "t"));
    expect(await store.delete("a")).toBe(true);
    expect(await store.getById("a")).toBeUndefined();
    expect(await store.delete("a")).toBe(false);
  });
});

describe("DynamoResponseCache", () => {
  let cache: DynamoResponseCache;
  let clock: ReturnType<typeof makeClock>;
  const TTL = 1000;

  beforeEach(async () => {
    await clearTables(deps, ["responseCache"]);
    clock = makeClock(10_000);
    cache = new DynamoResponseCache(deps, clock, TTL);
  });

  it("set then get returns the body within TTL", async () => {
    await cache.set("h1", "body1");
    const got = await cache.get("h1", TTL);
    expect(got?.body).toBe("body1");
    expect(got?.createdAt).toBe(10_000);
  });

  it("get past the per-call TTL returns undefined (defensive in-read check)", async () => {
    await cache.set("h1", "body1");
    clock.advance(TTL + 1);
    expect(await cache.get("h1", TTL)).toBeUndefined();
  });

  it("get for an unknown key returns undefined", async () => {
    expect(await cache.get("nope", TTL)).toBeUndefined();
  });

  it("set overwrites an existing entry", async () => {
    await cache.set("h1", "old");
    clock.advance(10);
    await cache.set("h1", "new");
    expect((await cache.get("h1", TTL))?.body).toBe("new");
  });
});

describe("DynamoPricingStore", () => {
  let store: DynamoPricingStore;

  beforeEach(async () => {
    await clearTables(deps, ["pricing"]);
    store = new DynamoPricingStore(deps);
  });

  const rec = (service: string, unit: string, usd: number, month: string, region = "us-east-1"): PriceRecord => ({
    service,
    region,
    unit,
    usd,
    month,
    note: `${service} ${unit}`,
  });

  it("get returns the rows of the freshest month, ordered by unit", async () => {
    await store.replaceMonth("us-east-1", "2026-05", [rec("Lambda", "gb-second", 0.1, "2026-05")]);
    await store.replaceMonth("us-east-1", "2026-06", [
      rec("Lambda", "per-1k-requests", 0.2, "2026-06"),
      rec("Lambda", "gb-second", 0.15, "2026-06"),
    ]);
    const got = await store.get("Lambda", "us-east-1");
    expect(got.map((r) => r.unit)).toEqual(["gb-second", "per-1k-requests"]);
    expect(got[0]!.usd).toBe(0.15); // freshest month only
  });

  it("replaceMonth swaps a month's rows atomically per region+month", async () => {
    await store.replaceMonth("us-east-1", "2026-06", [rec("S3", "gb-month", 0.02, "2026-06")]);
    await store.replaceMonth("us-east-1", "2026-06", [rec("S3", "gb-month", 0.03, "2026-06")]);
    const got = await store.get("S3", "us-east-1");
    expect(got).toHaveLength(1);
    expect(got[0]!.usd).toBe(0.03);
  });

  it("seed does not clobber a same-or-newer month", async () => {
    await store.replaceMonth("us-east-1", "2026-06", [rec("EC2", "hour", 0.05, "2026-06")]);
    await store.seed([rec("EC2", "hour", 0.99, "0000-00")]); // sentinel seed month — older
    expect((await store.get("EC2", "us-east-1"))[0]!.usd).toBe(0.05);
  });

  it("seed lays down facts when nothing is cached for the key", async () => {
    await store.seed([rec("SQS", "per-1k-requests", 0.4, "0000-00")]);
    expect((await store.get("SQS", "us-east-1"))[0]!.usd).toBe(0.4);
  });

  it("get returns [] for an unknown service", async () => {
    expect(await store.get("Nope", "us-east-1")).toEqual([]);
  });
});

describe("DynamoFeedbackStore", () => {
  let store: DynamoFeedbackStore;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(async () => {
    await clearTables(deps, ["feedback"]);
    clock = makeClock(1_000);
    store = new DynamoFeedbackStore(deps, clock);
  });

  const entry = (ip: string, promptHash: string, rating: 1 | -1) => ({
    promptHash,
    description: "d",
    answers: [] as string[],
    round: 0,
    recommendedTier: "balanced",
    body: null,
    rating,
    ip,
    comment: null,
  });

  it("upsert stores and returns the canonical entry", async () => {
    const saved = await store.upsert(entry("1.1.1.1", "ph1", 1));
    expect(saved.rating).toBe(1);
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBe(1_000);
  });

  it("a second verdict from the same IP on the same design CHANGES it (never stacks)", async () => {
    await store.upsert(entry("1.1.1.1", "ph1", 1));
    clock.advance(50);
    await store.upsert({ ...entry("1.1.1.1", "ph1", -1), recommendedTier: "resilient" });
    const down = await store.listByRating(-1, 10);
    const up = await store.listByRating(1, 10);
    expect(down).toHaveLength(1);
    expect(up).toHaveLength(0);
    expect(down[0]!.recommendedTier).toBe("resilient");
    expect(down[0]!.createdAt).toBe(1_000); // original createdAt preserved
  });

  it("listByRating returns newest-updated first, filtered by rating", async () => {
    await store.upsert(entry("1.1.1.1", "ph1", 1));
    clock.advance(10);
    await store.upsert(entry("2.2.2.2", "ph2", 1));
    clock.advance(10);
    await store.upsert(entry("3.3.3.3", "ph3", -1));
    const up = await store.listByRating(1, 10);
    expect(up.map((e) => e.ip)).toEqual(["2.2.2.2", "1.1.1.1"]);
  });

  it("usageStats aggregates totals + per-day up/down (counts only, no raw IPs)", async () => {
    const DAY = 86_400_000;
    await store.upsert(entry("1.1.1.1", "ph1", 1)); // 1970-01-01, up
    clock.advance(DAY);
    await store.upsert(entry("2.2.2.2", "ph2", -1)); // 1970-01-02, down
    await store.upsert(entry("3.3.3.3", "ph3", 1)); // 1970-01-02, up
    const stats = await store.usageStats();
    expect(stats).toEqual({
      total: 3,
      up: 2,
      down: 1,
      byDay: { "1970-01-01": { up: 1, down: 0 }, "1970-01-02": { up: 1, down: 1 } },
    });
  });
});

describe("DynamoDesignVectorStore", () => {
  let store: DynamoDesignVectorStore;

  beforeEach(async () => {
    await clearTables(deps, ["designVectors"]);
    store = new DynamoDesignVectorStore(deps, makeClock(1_000));
  });

  const upsert = (id: string, vector: number[], model = "voyage-3-lite", source: "generation" | "curated" = "generation") =>
    store.upsert({ id, source, promptHash: `ph-${id}`, text: `t-${id}`, vector, model });

  it("upsert + search ranks by cosine and respects topK", async () => {
    await upsert("a", [1, 0, 0]);
    await upsert("b", [0.9, 0.1, 0]);
    await upsert("c", [0, 1, 0]);
    const hits = await store.search([1, 0, 0], "voyage-3-lite", 2);
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(hits[0]!.similarity).toBeCloseTo(1, 5);
  });

  it("search only compares within the same model (never mixes embedding spaces)", async () => {
    await upsert("a", [1, 0, 0], "voyage-3-lite");
    await upsert("b", [1, 0, 0], "other-model");
    const hits = await store.search([1, 0, 0], "voyage-3-lite", 10);
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("hasForModel + count reflect the same-model corpus", async () => {
    await upsert("a", [1, 0, 0], "voyage-3-lite");
    await upsert("b", [0, 1, 0], "voyage-3-lite");
    expect(await store.hasForModel("a", "voyage-3-lite")).toBe(true);
    expect(await store.hasForModel("a", "other")).toBe(false);
    expect(await store.count("voyage-3-lite")).toBe(2);
  });

  it("upsert overwrites by id; delete removes and reports existence", async () => {
    await upsert("a", [1, 0, 0]);
    await upsert("a", [0, 1, 0]); // re-embed
    const hits = await store.search([0, 1, 0], "voyage-3-lite", 1);
    expect(hits[0]!.similarity).toBeCloseTo(1, 5);
    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
    expect(await store.count("voyage-3-lite")).toBe(0);
  });
});
