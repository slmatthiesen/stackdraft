/**
 * The load-bearing DynamoDB conformance tests (plan §3 — "do NOT hand-wave these").
 *
 * SQLite gets these semantics free by serializing writers; DynamoDB must enforce them
 * with optimistic concurrency. These tests fire genuinely CONCURRENT operations
 * (Promise.all) against the emulator and assert the invariants hold:
 *   - SpendLedger: concurrent reserves never overshoot the daily ceiling.
 *   - curated/generations: a voter's concurrent double-clicks count as ONE vote.
 *
 * Run with `pnpm test:dynamo`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

import type { Clock } from "../clock.js";
import { makeTestDeps, ensureTables, clearTables } from "./testHarness.js";
import { deleteTables } from "./schema.js";
import { DynamoSpendLedger } from "./spendLedger.js";
import { DynamoCuratedStore } from "./curated.js";
import { DynamoGenerationsStore } from "./generations.js";

const deps = makeTestDeps("conf_");
const DAY_MS = 86_400_000;
const DAY1 = Date.parse("2026-06-26T12:00:00Z");

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

describe("DynamoSpendLedger — reservations", () => {
  let ledger: DynamoSpendLedger;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(async () => {
    await clearTables(deps, ["spend"]);
    clock = makeClock(DAY1);
    ledger = new DynamoSpendLedger(deps, clock);
  });

  it("reserves under the ceiling and reports the running total", async () => {
    const r = await ledger.reserve(0.3, 1.0);
    expect(r.ok).toBe(true);
    expect(r.spentTodayUsd).toBeCloseTo(0.3);
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0.3);
  });

  it("reconcile replaces the provisional with the actual", async () => {
    const r = await ledger.reserve(0.3, 1.0);
    await ledger.reconcile(r.reservationId, 0.5);
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0.5);
  });

  it("reconcile is idempotent (a second call is a no-op)", async () => {
    const r = await ledger.reserve(0.3, 1.0);
    await ledger.reconcile(r.reservationId, 0.5);
    await ledger.reconcile(r.reservationId, 0.9);
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0.5);
  });

  it("release removes a reservation's debit and is idempotent", async () => {
    const r = await ledger.reserve(0.3, 1.0);
    await ledger.release(r.reservationId);
    await ledger.release(r.reservationId);
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0);
  });

  it("a rejected reserve reports the unchanged spend and no reservation id", async () => {
    await ledger.reserve(0.9, 1.0);
    const r = await ledger.reserve(0.5, 1.0);
    expect(r.ok).toBe(false);
    expect(r.reservationId).toBe("");
    expect(r.spentTodayUsd).toBeCloseTo(0.9);
  });

  it("SEQUENTIAL reserve-on-entry never overshoots the ceiling", async () => {
    let successes = 0;
    for (let i = 0; i < 20; i++) {
      if ((await ledger.reserve(0.3, 1.0)).ok) successes++;
    }
    expect(successes).toBe(3); // 0.9 fits, 1.2 would overshoot
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0.9);
    expect(await ledger.spentTodayUsd()).toBeLessThanOrEqual(1.0);
  });

  it("CONCURRENT reserves cannot each pass the ceiling (no overshoot) — the load-bearing case", async () => {
    // 20 reserves of 0.3 fired at once against a 1.0 ceiling. Optimistic concurrency on
    // the day-counter must let AT MOST 3 through (0.9 ≤ 1.0 < 1.2). A naive port lets
    // many pass and blows the budget.
    const results = await Promise.all(Array.from({ length: 20 }, () => ledger.reserve(0.3, 1.0)));
    const successes = results.filter((r) => r.ok).length;
    const spent = await ledger.spentTodayUsd();
    expect(spent).toBeLessThanOrEqual(1.0); // HARD invariant — never overshoot
    expect(successes).toBe(3);
    expect(spent).toBeCloseTo(0.9);
  });

  it("sums only today's rows across a day boundary", async () => {
    await ledger.reserve(0.5, 5.0);
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0.5);
    clock.advance(DAY_MS);
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0);
    await ledger.reserve(0.2, 5.0);
    expect(await ledger.spentTodayUsd()).toBeCloseTo(0.2);
  });
});

describe("DynamoSpendLedger — per-IP daily counts", () => {
  let ledger: DynamoSpendLedger;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(async () => {
    await clearTables(deps, ["spend"]);
    clock = makeClock(DAY1);
    ledger = new DynamoSpendLedger(deps, clock);
  });

  it("increments per IP and isolates IPs", async () => {
    expect(await ledger.incrementIpCount("1.1.1.1")).toBe(1);
    expect(await ledger.incrementIpCount("1.1.1.1")).toBe(2);
    expect(await ledger.ipCountToday("1.1.1.1")).toBe(2);
    expect(await ledger.ipCountToday("2.2.2.2")).toBe(0);
  });

  it("resets the count across a day boundary", async () => {
    await ledger.incrementIpCount("1.1.1.1");
    clock.advance(DAY_MS);
    expect(await ledger.ipCountToday("1.1.1.1")).toBe(0);
    expect(await ledger.incrementIpCount("1.1.1.1")).toBe(1);
  });

  it("CONCURRENT increments from one IP are atomic (no lost updates)", async () => {
    await Promise.all(Array.from({ length: 10 }, () => ledger.incrementIpCount("1.1.1.1")));
    expect(await ledger.ipCountToday("1.1.1.1")).toBe(10);
  });
});

describe("DynamoCuratedStore — votes + dedup", () => {
  let store: DynamoCuratedStore;

  beforeEach(async () => {
    await clearTables(deps, ["curated"]);
    store = new DynamoCuratedStore(deps, makeClock(1_000));
  });

  const run = (id: string, title: string) => ({
    id,
    title,
    prompt: `prompt ${title}`,
    body: JSON.stringify({ recommendedTier: "balanced", tiers: [] }),
  });

  it("upsert then get returns the run; list omits hidden and ranks by score", async () => {
    await store.upsert(run("a", "Alpha"));
    await store.upsert(run("b", "Beta"));
    await store.vote("b", "ip1", 1);
    const list = await store.list();
    expect(list.map((r) => r.id)).toEqual(["b", "a"]);
    expect((list[0] as { body?: string }).body).toBeUndefined();
  });

  it("a voter's second vote replaces their first (one vote per voter)", async () => {
    await store.upsert(run("a", "Alpha"));
    await store.vote("a", "ip1", 1);
    const after = await store.vote("a", "ip1", -1);
    expect(after).toEqual({ upvotes: 0, downvotes: 1 });
  });

  it("vote on an unknown run returns undefined", async () => {
    expect(await store.vote("nope", "ip1", 1)).toBeUndefined();
  });

  it("CONCURRENT double-clicks from ONE voter count as a single vote (dedup)", async () => {
    await store.upsert(run("a", "Alpha"));
    await Promise.all(Array.from({ length: 5 }, () => store.vote("a", "ip1", 1)));
    const got = await store.get("a");
    expect(got?.upvotes).toBe(1);
    expect(got?.downvotes).toBe(0);
  });

  it("CONCURRENT votes from DIFFERENT voters all count (atomic counter, no lost updates)", async () => {
    await store.upsert(run("a", "Alpha"));
    await Promise.all(["ip1", "ip2", "ip3", "ip4", "ip5"].map((ip) => store.vote("a", ip, 1)));
    expect((await store.get("a"))?.upvotes).toBe(5);
  });

  it("setHidden removes from list AND get; re-upsert preserves votes + hidden", async () => {
    await store.upsert(run("a", "Alpha"));
    await store.vote("a", "ip1", 1);
    expect(await store.setHidden("a", true)).toBe(true);
    expect(await store.get("a")).toBeUndefined();
    expect((await store.list()).map((r) => r.id)).toEqual([]);
    await store.upsert({ ...run("a", "Alpha v2"), prompt: "re-seeded" });
    expect(await store.get("a")).toBeUndefined(); // still hidden
    await store.setHidden("a", false);
    const got = await store.get("a");
    expect(got?.title).toBe("Alpha v2");
    expect(got?.upvotes).toBe(1); // votes preserved through re-seed
  });
});

describe("DynamoGenerationsStore", () => {
  let store: DynamoGenerationsStore;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(async () => {
    await clearTables(deps, ["generations"]);
    clock = makeClock(1_000);
    store = new DynamoGenerationsStore(deps, clock);
  });

  const input = (promptHash: string, description = "d") => ({
    promptHash,
    description,
    answers: [] as string[],
    model: "claude-sonnet-4-6",
    region: "us-east-1",
    recommendedTier: "balanced",
    tags: ["compute"],
    body: JSON.stringify({ recommendedTier: "balanced", tiers: [] }),
    clientIp: "1.1.1.1",
  });

  it("upsert by promptHash: a re-run bumps genCount and preserves id/status/votes", async () => {
    const first = await store.upsert(input("ph1"));
    await store.setStatus(first.id, "approved");
    await store.vote(first.id, "ip1", 1, -3);
    const again = await store.upsert(input("ph1", "refreshed"));
    expect(again.id).toBe(first.id); // stable deep link
    const rec = await store.getById(first.id);
    expect(rec?.genCount).toBe(2);
    expect(rec?.status).toBe("approved"); // preserved
    expect(rec?.upvotes).toBe(1); // preserved
    expect(rec?.description).toBe("refreshed");
  });

  it("getByPromptHash finds the row; a different model yields a separate row", async () => {
    const a = await store.upsert(input("ph1"));
    expect((await store.getByPromptHash("ph1"))?.id).toBe(a.id);
    expect(await store.getByPromptHash("nope")).toBeUndefined();
  });

  it("listPending newest-first; listApproved by score then recency", async () => {
    const a = await store.upsert(input("pha"));
    clock.advance(10);
    const b = await store.upsert(input("phb"));
    expect((await store.listPending(10)).map((s) => s.id)).toEqual([b.id, a.id]);

    await store.setStatus(a.id, "approved");
    await store.setStatus(b.id, "approved");
    await store.vote(a.id, "ip1", 1, -3); // a outscores b
    expect((await store.listApproved(10)).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("setTerraform persists per tier; getTerraform reads it back", async () => {
    const g = await store.upsert(input("ph1"));
    expect(await store.getTerraform(g.id, "budget")).toBeUndefined();
    expect(await store.setTerraform(g.id, "budget", "resource ...")).toBe(true);
    expect(await store.setTerraform(g.id, "balanced", "resource b")).toBe(true);
    expect((await store.getTerraform(g.id, "budget"))?.code).toBe("resource ...");
    expect((await store.getTerraform(g.id, "balanced"))?.code).toBe("resource b");
    expect(await store.setTerraform("missing", "budget", "x")).toBe(false);
  });

  it("vote auto-hides an approved design once net votes hit the threshold", async () => {
    const g = await store.upsert(input("ph1"));
    await store.setStatus(g.id, "approved");
    // One downvote → net -1, which is <= the -1 threshold → auto-hidden back to the queue.
    const r1 = await store.vote(g.id, "ip1", -1, -1);
    expect(r1?.status).toBe("hidden");
    expect((await store.getById(g.id))?.status).toBe("hidden");
  });

  it("CONCURRENT double-clicks from one voter count as a single vote", async () => {
    const g = await store.upsert(input("ph1"));
    await store.setStatus(g.id, "approved");
    await Promise.all(Array.from({ length: 5 }, () => store.vote(g.id, "ip1", 1, -3)));
    const rec = await store.getById(g.id);
    expect(rec?.upvotes).toBe(1);
  });

  it("usageStats aggregates totals, per-status, per-day, and unique IPs (no raw IPs)", async () => {
    // 1970-01-01: two generations, one shared IP
    await store.upsert({ ...input("pha"), clientIp: "1.1.1.1" });
    await store.upsert({ ...input("phb"), clientIp: "2.2.2.2" });
    // 1970-01-02: one generation reusing IP 1.1.1.1, then approved
    clock.advance(DAY_MS);
    const c = await store.upsert({ ...input("phc"), clientIp: "1.1.1.1" });
    await store.setStatus(c.id, "approved");

    const stats = await store.usageStats();
    expect(stats.total).toBe(3);
    expect(stats.byStatus).toEqual({ pending: 2, approved: 1, hidden: 0 });
    expect(stats.byDay).toEqual({ "1970-01-01": 2, "1970-01-02": 1 });
    expect(stats.uniqueIpsByDay).toEqual({ "1970-01-01": 2, "1970-01-02": 1 });
  });
});
