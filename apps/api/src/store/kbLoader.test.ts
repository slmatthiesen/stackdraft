import { describe, it, expect, beforeEach } from "vitest";

import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import referenceArchitectures from "@drafture/kb/reference-architectures.json" with { type: "json" };
import type { SecurityBaseline, ReferenceArchitecture } from "@drafture/kb";

import { openTempDb, createStores, type Db, type Stores } from "./sqlite.js";
import { seedKnowledgeBase, SEED_PRICING_MONTH } from "./kbLoader.js";

const REGION = "us-east-1";

function countMemoryDocs(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM memory_docs`).get() as { c: number };
  return row.c;
}

function countPricingRows(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM pricing`).get() as { c: number };
  return row.c;
}

const baselines = securityBaselines as SecurityBaseline[];
const patterns = referenceArchitectures as ReferenceArchitecture[];

describe("seedKnowledgeBase", () => {
  let db: Db;
  let stores: Stores;

  beforeEach(() => {
    db = openTempDb();
    stores = createStores(db);
  });

  it("loads all baselines, patterns, and pricing facts", () => {
    const summary = seedKnowledgeBase(stores);

    expect(summary.baselines).toBe(baselines.length);
    expect(summary.patterns).toBe(patterns.length);
    expect(summary.pricingFacts).toBeGreaterThanOrEqual(12);

    // Every baseline + pattern is retrievable by its namespaced topic.
    for (const b of baselines) {
      const doc = stores.memory.get(`security:${b.id}`);
      expect(doc?.verified).toBe(true);
      expect(doc?.provenance).toBe("seed");
      expect(doc?.fact).toBe(b.rule);
    }
    for (const p of patterns) {
      const doc = stores.memory.get(`pattern:${p.id}`);
      expect(doc?.verified).toBe(true);
      expect(doc?.fact).toContain(p.name);
    }

    expect(countMemoryDocs(db)).toBe(baselines.length + patterns.length);
    // Pricing rows seeded under the sentinel month.
    expect(countPricingRows(db)).toBe(summary.pricingFacts);
    const lambda = stores.pricing.get("Lambda", REGION);
    expect(lambda.length).toBeGreaterThan(0);
    expect(lambda[0]?.month).toBe(SEED_PRICING_MONTH);
  });

  it("is idempotent: re-running does not duplicate rows", () => {
    seedKnowledgeBase(stores);
    const memAfterFirst = countMemoryDocs(db);
    const priceAfterFirst = countPricingRows(db);

    seedKnowledgeBase(stores);
    seedKnowledgeBase(stores);

    expect(countMemoryDocs(db)).toBe(memAfterFirst);
    expect(countPricingRows(db)).toBe(priceAfterFirst);
  });

  it("every security baseline has a non-empty rationale + source (R7)", () => {
    seedKnowledgeBase(stores);
    for (const b of baselines) {
      const doc = stores.memory.get(`security:${b.id}`);
      expect(doc).toBeDefined();
      expect(doc!.rationale.trim().length).toBeGreaterThan(0);
      expect(doc!.source).toMatch(/^https?:\/\//);
    }
  });

  it("pricing seed covers every service referenced by the seed reference-architectures", () => {
    seedKnowledgeBase(stores);
    const referenced = new Set(patterns.flatMap((p) => p.services));
    expect(referenced.size).toBeGreaterThan(0);
    for (const service of referenced) {
      const records = stores.pricing.get(service, REGION);
      expect(records.length, `no pricing fact for "${service}"`).toBeGreaterThan(0);
    }
  });

  it("includes the data-transfer / NAT-gateway cost lines (KTD6)", () => {
    seedKnowledgeBase(stores);

    const dt = stores.pricing.get("Data Transfer", REGION);
    const dtUnits = dt.map((r) => r.unit);
    expect(dtUnits).toContain("gb-internet-egress");
    expect(dtUnits).toContain("gb-cross-az");

    const nat = stores.pricing.get("NAT Gateway", REGION);
    const natUnits = nat.map((r) => r.unit);
    expect(natUnits).toContain("gb-processed");
    expect(natUnits).toContain("hour");
  });
});
