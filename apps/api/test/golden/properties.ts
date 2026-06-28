/**
 * Golden-set property checkers (U15/R16).
 *
 * We assert PROPERTIES of a generated {@link ArchitectureResult}, never exact
 * text — an LLM phrases things a hundred ways, so brittle string-equality would
 * fail on cosmetic drift while still missing real regressions. Each checker
 * matches by keyword/id against a robust vocabulary: loose enough to survive
 * rewording, tight enough that the known-bad fixture (a tier that drops a
 * baseline, an unlabeled edge) actually trips the gate.
 *
 * The runner (src/eval/runner.ts) aggregates these across the prompt set into a
 * pass-rate, which is the TRACKED metric (not asserted at a fixed value) — it
 * gates model/KB swaps by flagging a drop, not by hard-coding a number.
 */
import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import type { SecurityBaseline } from "@drafture/kb";

import { TIER_NAMES } from "../../src/schema/architecture.js";
import type { ArchitectureResult, Tier } from "../../src/schema/architecture.js";

const baselines = securityBaselines as SecurityBaseline[];

export type PropertyName =
  | "exactlyThreeTiers"
  | "securityFloorCoversAllBaselines"
  | "allEdgesPayloadLabeled"
  | "onDemandDisclaimerPresent"
  | "noBannedServices"
  | "recommendsATier"
  | "hasKeyDecisions"
  | "queuesAreResilient";

export interface PropertyResult {
  name: PropertyName;
  ok: boolean;
  /** Human-readable explanation; empty-ish on pass, specific on fail. */
  reason: string;
}

export type Property = (result: ArchitectureResult) => PropertyResult;

// --- Baseline coverage vocabulary -------------------------------------------
//
// Each of the eight seeded baselines maps to a set of distinctive keywords. The
// LEANER SHAPE states the security floor ONCE, so coverage is asserted against
// the GLOBAL `securityFloor` (not repeated per tier): the floor "covers" a
// baseline if ANY keyword appears in it. Matching is case-insensitive substring.
// New baselines added to the KB without an entry here fall back to keywords
// derived from their id (so coverage tracking never silently ignores a new rule).

const BASELINE_KEYWORDS: Record<string, readonly string[]> = {
  "encrypt-at-rest": ["at rest", "encrypt", "kms", "sse"],
  "encrypt-in-transit": ["in transit", "tls", "https", "securetransport"],
  "least-privilege-iam": ["least-privilege", "least privilege", "least-priv", "scoped role", "iam"],
  "s3-block-public-access": ["block public access", "block-public-access", "no public bucket"],
  "no-public-data-tier": ["private subnet", "private-subnet", "no public data", "no public route"],
  "secrets-manager": ["secrets manager", "secrets-manager", "parameter store", "ssm", "secret"],
  "edge-protection": ["waf", "cloudfront", "shield", "edge protection"],
  "audit-and-access-logging": ["cloudtrail", "access logging", "access-logging", "flow logs", "audit log"],
};

function keywordsForBaseline(b: SecurityBaseline): readonly string[] {
  return BASELINE_KEYWORDS[b.id] ?? b.id.split("-");
}

/** The text a baseline is evidenced in: the global, stated-once security floor. */
function securityFloorSurface(result: ArchitectureResult): string {
  return result.securityFloor.join(" ").toLowerCase();
}

function coversBaseline(surface: string, b: SecurityBaseline): boolean {
  return keywordsForBaseline(b).some((kw) => surface.includes(kw.toLowerCase()));
}

/**
 * R7 — the GLOBAL `securityFloor` must reflect ALL eight security baselines,
 * stated once. It applies to every tier (budget included — the minimum *safe*
 * cost, not a security-relaxed tier), so a baseline missing from the floor is a
 * hard fail.
 */
export const securityFloorCoversAllBaselines: Property = (result) => {
  const surface = securityFloorSurface(result);
  const missing = baselines.filter((b) => !coversBaseline(surface, b)).map((b) => b.id);
  return {
    name: "securityFloorCoversAllBaselines",
    ok: missing.length === 0,
    reason:
      missing.length === 0
        ? `securityFloor covers all ${baselines.length} baselines`
        : `uncovered: ${missing.join(", ")}`,
  };
};

/** R4 — every edge in every tier carries a non-empty payload label. */
export const allEdgesPayloadLabeled: Property = (result) => {
  const unlabeled: string[] = [];
  for (const tier of result.tiers) {
    tier.edges.forEach((edge, i) => {
      if (edge.payload.trim().length === 0) unlabeled.push(`${tier.name}:edge[${i}] ${edge.from}->${edge.to}`);
    });
  }
  return {
    name: "allEdgesPayloadLabeled",
    ok: unlabeled.length === 0,
    reason: unlabeled.length === 0 ? "every edge payload-labeled" : `unlabeled edges: ${unlabeled.join(", ")}`,
  };
};

// --- On-demand list-price disclaimer (R6) -----------------------------------
//
// Costs are always disclaimed as on-demand list prices for the default region.
// The disclaimer may live in assumptions or in a cost-driver note, so we search
// both. "list price" (covers price/prices) is the load-bearing phrase.

function costDisclaimerSurface(result: ArchitectureResult): string {
  const noteText = result.tiers.flatMap((t) => t.costDrivers.map((d) => d.note)).join(" ");
  return `${result.assumptions.join(" ")} ${noteText}`.toLowerCase();
}

export const onDemandDisclaimerPresent: Property = (result) => {
  const surface = costDisclaimerSurface(result);
  const ok = surface.includes("list price");
  return {
    name: "onDemandDisclaimerPresent",
    ok,
    reason: ok ? "on-demand list-price disclaimer present" : "no list-price disclaimer in assumptions or cost notes",
  };
};

// --- Banned services (safe-by-default floor) --------------------------------
//
// A small deny-list of deprecated / insecure-by-default choices that must never
// appear in a recommended design. Chosen because each is a concrete, unambiguous
// anti-pattern the tool's safe-by-default posture (R7) forbids:
//   - "ec2-classic"      : retired flat network with no VPC isolation.
//   - "public s3 bucket" : a publicly readable bucket — the canonical AWS leak (R7 #4).
//   - "0.0.0.0/0"        : world-open security-group ingress on a data/admin port.
//   - "root access key"  : long-lived root credentials — violates least-privilege (R7 #3).
//   - "http://"          : a plaintext endpoint — violates encrypt-in-transit (R7 #2).
//
// We scan only the CONCRETE design surface (node service/role/security tags, edge
// protocol/payload, cost-driver fields) — not the delta/tradeoffs prose, which
// legitimately mention these terms in NEGATED form ("no public bucket").
// A negation guard further suppresses negated mentions on the scanned surface.
export const BANNED_SERVICES = [
  "ec2-classic",
  "public s3 bucket",
  "0.0.0.0/0",
  "root access key",
  "http://",
] as const;

const NEGATION = /\b(no|not|never|without|block|blocks|blocked|deny|denies|denied|disable|disabled|prevent|prevents)\b/;

function designSurfaceStrings(result: ArchitectureResult): string[] {
  const out: string[] = [];
  for (const tier of result.tiers) {
    for (const n of tier.nodes) {
      out.push(n.awsService, n.role, ...n.security);
    }
    for (const e of tier.edges) {
      out.push(e.protocol, e.payload);
    }
    for (const d of tier.costDrivers) {
      out.push(d.service, d.unit, d.note);
    }
  }
  return out;
}

function bannedHit(surface: string, token: string): boolean {
  const lower = surface.toLowerCase();
  const idx = lower.indexOf(token);
  if (idx === -1) return false;
  // Suppress negated mentions ("no public s3 bucket", "block 0.0.0.0/0").
  const prefix = lower.slice(Math.max(0, idx - 24), idx);
  return !NEGATION.test(prefix);
}

export const noBannedServices: Property = (result) => {
  const surfaces = designSurfaceStrings(result);
  const found: string[] = [];
  for (const token of BANNED_SERVICES) {
    if (surfaces.some((s) => bannedHit(s, token))) found.push(token);
  }
  return {
    name: "noBannedServices",
    ok: found.length === 0,
    reason: found.length === 0 ? "no banned services present" : `banned present: ${found.join(", ")}`,
  };
};

// --- Default-selected tier --------------------------------------------------

/** The model no longer picks a tier; the backend injects a deterministic default
 *  (the medium tier the UI pre-selects). It must still be a valid tier name. */
export const recommendsATier: Property = (result) => {
  const ok = (TIER_NAMES as readonly string[]).includes(result.recommendedTier);
  return {
    name: "recommendsATier",
    ok,
    reason: ok
      ? `default-selected tier is '${result.recommendedTier}'`
      : `recommendedTier '${result.recommendedTier}' is not one of [${TIER_NAMES.join(",")}]`,
  };
};

// --- ADR-style key decisions (alternatives weighed + why) -------------------

/** Load-bearing decisions must be present and each must actually reason. */
export const hasKeyDecisions: Property = (result) => {
  if (result.keyDecisions.length === 0) {
    return { name: "hasKeyDecisions", ok: false, reason: "keyDecisions is empty — no load-bearing decisions surfaced" };
  }
  const weak: string[] = [];
  result.keyDecisions.forEach((d, i) => {
    if (d.chosen.trim().length === 0) weak.push(`decision[${i}] missing 'chosen'`);
    if (d.rationale.trim().length === 0) weak.push(`decision[${i}] missing 'rationale'`);
    if (d.alternativesConsidered.length === 0) weak.push(`decision[${i}] no alternativesConsidered`);
  });
  return {
    name: "hasKeyDecisions",
    ok: weak.length === 0,
    reason: weak.length === 0 ? `${result.keyDecisions.length} key decisions with chosen+rationale+alternatives` : weak.join(", "),
  };
};

// --- Resilient queues (at-least-once → idempotency + DLQ) -------------------
//
// A queue/topic implies at-least-once delivery, so the senior-architect floor is:
// the tier that introduces it MUST evidence a dead-letter path AND idempotent
// consumption. LEANER SHAPE: that resilience is now carried in the STRUCTURE —
// node `security` TAGS (a queue node tagged "DLQ", its consumer tagged "idempotent
// consumer") plus the tier `delta` and `tradeoffs`. We detect a queue by
// service/role keyword, then require both signals across that tier's tags + delta
// + tradeoffs (and we also count the global keyDecisions, which legitimately carry
// the reasoning). Tiers with no queue pass trivially.

const QUEUE_KEYWORDS = ["sqs", "queue", "sns", "eventbridge", "kinesis", "message"] as const;
const DLQ_KEYWORDS = ["dead-letter", "dead letter", "dlq"] as const;
const IDEMPOTENCY_KEYWORDS = ["idempotent", "idempotency", "dedupe", "deduplicat"] as const;

function tierHasQueue(tier: Tier): boolean {
  return tier.nodes.some((n) => {
    const surface = `${n.awsService} ${n.role}`.toLowerCase();
    return QUEUE_KEYWORDS.some((kw) => surface.includes(kw));
  });
}

/** The structural surface a tier can evidence queue resilience in: node security
 *  TAGS + the robustness delta + tradeoffs (the lean replacement for the old
 *  securityNotes/burstHandling/setupSteps prose). */
function tierResilienceSurface(tier: Tier): string {
  return [...tier.nodes.flatMap((n) => n.security), ...tier.delta, ...tier.tradeoffs]
    .join(" ")
    .toLowerCase();
}

export const queuesAreResilient: Property = (result) => {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    if (!tierHasQueue(tier)) continue; // no queue → trivially resilient
    const surface = tierResilienceSurface(tier);
    const hasDlq = DLQ_KEYWORDS.some((kw) => surface.includes(kw));
    const hasIdempotency = IDEMPOTENCY_KEYWORDS.some((kw) => surface.includes(kw));
    if (!hasDlq) offenders.push(`${tier.name}: queue without a dead-letter/DLQ mention`);
    if (!hasIdempotency) offenders.push(`${tier.name}: queue without idempotency/dedupe mention`);
  }
  return {
    name: "queuesAreResilient",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every queue-bearing tier covers DLQ + idempotency" : offenders.join("; "),
  };
};

/** R3 — exactly budget/balanced/resilient, no more, no fewer. */
export const exactlyThreeTiers: Property = (result) => {
  const names = result.tiers.map((t) => t.name);
  const expected = [...TIER_NAMES].sort().join(",");
  const actual = [...names].sort().join(",");
  const ok = result.tiers.length === 3 && actual === expected;
  return {
    name: "exactlyThreeTiers",
    ok,
    reason: ok ? "budget/balanced/resilient present" : `expected [${expected}], got [${names.join(",")}]`,
  };
};

export const ALL_PROPERTIES: readonly Property[] = [
  exactlyThreeTiers,
  securityFloorCoversAllBaselines,
  allEdgesPayloadLabeled,
  onDemandDisclaimerPresent,
  noBannedServices,
  recommendsATier,
  hasKeyDecisions,
  queuesAreResilient,
];

export interface AggregateResult {
  ok: boolean;
  results: PropertyResult[];
}

/** Run every property and aggregate; `ok` is true only if all pass. */
export function runAllProperties(result: ArchitectureResult): AggregateResult {
  const results = ALL_PROPERTIES.map((p) => p(result));
  return { ok: results.every((r) => r.ok), results };
}
