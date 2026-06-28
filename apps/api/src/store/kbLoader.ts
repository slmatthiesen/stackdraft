/**
 * Idempotent seeding of the curated KB (U4) into the stores on boot.
 *
 * Security baselines + reference architectures land in `MemoryStore` as verified
 * seed docs (so grounding treats them as trusted); pricing facts land in
 * `PricingStore` under a sentinel month so a real monthly refresh always wins.
 *
 * Re-running is safe: MemoryStore.upsert is keyed by id, and the pricing snapshot
 * is written with `replaceMonth` (delete+reinsert the sentinel month) so the row
 * count is stable across boots. `replaceMonth` — not `seed` — is required here
 * because the seed facts are multi-unit per service (Lambda $/request + $/GB-s,
 * NAT $/GB + $/hr, ...); `seed`'s same-or-newer-month guard is keyed only by
 * (service, region), so it would drop every unit after the first for a service.
 * The sentinel month sorts below any real "YYYY-MM", so replacing it never
 * touches a refreshed snapshot and `get` still prefers the real month.
 */
import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import referenceArchitectures from "@drafture/kb/reference-architectures.json" with { type: "json" };
import pricingFacts from "@drafture/kb/pricing-facts.seed.json" with { type: "json" };
import type {
  SecurityBaseline,
  ReferenceArchitecture,
  PricingFact,
} from "@drafture/kb";

import type { MemoryStore, PricingStore, PriceRecord } from "./types.js";

/**
 * Sentinel month for seed pricing. Sorts BELOW any real "YYYY-MM" snapshot
 * (so PricingStore.get prefers a refreshed month and PricingStore.seed treats a
 * real month as fresher and skips re-seeding).
 */
export const SEED_PRICING_MONTH = "0000-00";

export interface SeedableStores {
  memory: MemoryStore;
  pricing: PricingStore;
}

function groupByRegion(records: PriceRecord[]): Map<string, PriceRecord[]> {
  const byRegion = new Map<string, PriceRecord[]>();
  for (const r of records) {
    const bucket = byRegion.get(r.region);
    if (bucket) bucket.push(r);
    else byRegion.set(r.region, [r]);
  }
  return byRegion;
}

function baselineToDoc(b: SecurityBaseline): Parameters<MemoryStore["upsert"]>[0] {
  return {
    id: `security:${b.id}`,
    topic: `security:${b.id}`,
    fact: b.rule,
    rationale: b.rationale,
    source: b.source,
    verified: true,
    provenance: "seed",
  };
}

function patternToDoc(p: ReferenceArchitecture): Parameters<MemoryStore["upsert"]>[0] {
  return {
    id: `pattern:${p.id}`,
    topic: `pattern:${p.id}`,
    fact: `Pattern '${p.name}' uses ${p.services.join(", ")}. Burst handling: ${p.burstMechanisms.join("; ")}.`,
    rationale: p.whenToUse,
    source: p.source,
    verified: true,
    provenance: "seed",
  };
}

function factToRecord(f: PricingFact): PriceRecord {
  return {
    service: f.service,
    region: f.region,
    unit: f.unit,
    usd: f.usd,
    month: SEED_PRICING_MONTH,
    note: f.note,
  };
}

export interface SeedSummary {
  baselines: number;
  patterns: number;
  pricingFacts: number;
}

/** Seed the curated KB into the stores. Idempotent — safe to call on every boot. */
export function seedKnowledgeBase(stores: SeedableStores): SeedSummary {
  const baselines = securityBaselines as SecurityBaseline[];
  const patterns = referenceArchitectures as ReferenceArchitecture[];
  const facts = pricingFacts as PricingFact[];

  for (const b of baselines) stores.memory.upsert(baselineToDoc(b));
  for (const p of patterns) stores.memory.upsert(patternToDoc(p));

  for (const [region, records] of groupByRegion(facts.map(factToRecord))) {
    stores.pricing.replaceMonth(region, SEED_PRICING_MONTH, records);
  }

  return {
    baselines: baselines.length,
    patterns: patterns.length,
    pricingFacts: facts.length,
  };
}
