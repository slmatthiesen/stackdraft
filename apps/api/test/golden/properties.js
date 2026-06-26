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
import securityBaselines from "@stackdraft/kb/security-baselines.json" with { type: "json" };
import { TIER_NAMES } from "../../src/schema/architecture.js";
const baselines = securityBaselines;
// --- Baseline coverage vocabulary -------------------------------------------
//
// Each of the eight seeded baselines maps to a set of distinctive keywords. A
// tier "covers" a baseline if ANY keyword appears in that tier's security
// surface (securityNotes + every node's awsService/purpose/security). Matching
// is case-insensitive substring. New baselines added to the KB without an entry
// here fall back to keywords derived from their id (so coverage tracking never
// silently ignores a new rule).
const BASELINE_KEYWORDS = {
    "encrypt-at-rest": ["at rest", "encrypt", "kms", "sse"],
    "encrypt-in-transit": ["in transit", "tls", "https", "securetransport"],
    "least-privilege-iam": ["least-privilege", "least privilege", "least-priv", "scoped role", "iam"],
    "s3-block-public-access": ["block public access", "block-public-access", "no public bucket"],
    "no-public-data-tier": ["private subnet", "private-subnet", "no public data", "no public route"],
    "secrets-manager": ["secrets manager", "secrets-manager", "parameter store", "ssm", "secret"],
    "edge-protection": ["waf", "cloudfront", "shield", "edge protection"],
    "audit-and-access-logging": ["cloudtrail", "access logging", "access-logging", "flow logs", "audit log"],
};
function keywordsForBaseline(b) {
    return BASELINE_KEYWORDS[b.id] ?? b.id.split("-");
}
/** The text a baseline can be evidenced in: the tier's security-bearing fields. */
function tierSecuritySurface(tier) {
    const nodeText = tier.nodes
        .map((n) => `${n.awsService} ${n.purpose} ${n.security.join(" ")}`)
        .join(" ");
    return `${tier.securityNotes.join(" ")} ${nodeText}`.toLowerCase();
}
function coversBaseline(surface, b) {
    return keywordsForBaseline(b).some((kw) => surface.includes(kw.toLowerCase()));
}
/**
 * R7 — every one of the three tiers must collectively reflect ALL eight security
 * baselines. Budget is the minimum *safe* cost, not a security-relaxed tier, so
 * a missing baseline on any tier is a hard fail.
 */
export const everyTierCoversAllBaselines = (result) => {
    const missing = [];
    for (const tier of result.tiers) {
        const surface = tierSecuritySurface(tier);
        for (const b of baselines) {
            if (!coversBaseline(surface, b))
                missing.push(`${tier.name}:${b.id}`);
        }
    }
    return {
        name: "everyTierCoversAllBaselines",
        ok: missing.length === 0,
        reason: missing.length === 0 ? `all ${baselines.length} baselines covered on every tier` : `uncovered: ${missing.join(", ")}`,
    };
};
/** R4 — every edge in every tier carries a non-empty payload label. */
export const allEdgesPayloadLabeled = (result) => {
    const unlabeled = [];
    for (const tier of result.tiers) {
        tier.edges.forEach((edge, i) => {
            if (edge.payload.trim().length === 0)
                unlabeled.push(`${tier.name}:edge[${i}] ${edge.from}->${edge.to}`);
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
function costDisclaimerSurface(result) {
    const noteText = result.tiers.flatMap((t) => t.costDrivers.map((d) => d.note)).join(" ");
    return `${result.assumptions.join(" ")} ${noteText}`.toLowerCase();
}
export const onDemandDisclaimerPresent = (result) => {
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
// We scan only the CONCRETE design surface (node service/purpose/security, edge
// protocol/payload, cost-driver fields) — not securityNotes/tradeoffs prose,
// which legitimately mention these terms in NEGATED form ("no public bucket").
// A negation guard further suppresses negated mentions on the scanned surface.
export const BANNED_SERVICES = [
    "ec2-classic",
    "public s3 bucket",
    "0.0.0.0/0",
    "root access key",
    "http://",
];
const NEGATION = /\b(no|not|never|without|block|blocks|blocked|deny|denies|denied|disable|disabled|prevent|prevents)\b/;
function designSurfaceStrings(result) {
    const out = [];
    for (const tier of result.tiers) {
        for (const n of tier.nodes) {
            out.push(n.awsService, n.purpose, ...n.security);
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
function bannedHit(surface, token) {
    const lower = surface.toLowerCase();
    const idx = lower.indexOf(token);
    if (idx === -1)
        return false;
    // Suppress negated mentions ("no public s3 bucket", "block 0.0.0.0/0").
    const prefix = lower.slice(Math.max(0, idx - 24), idx);
    return !NEGATION.test(prefix);
}
export const noBannedServices = (result) => {
    const surfaces = designSurfaceStrings(result);
    const found = [];
    for (const token of BANNED_SERVICES) {
        if (surfaces.some((s) => bannedHit(s, token)))
            found.push(token);
    }
    return {
        name: "noBannedServices",
        ok: found.length === 0,
        reason: found.length === 0 ? "no banned services present" : `banned present: ${found.join(", ")}`,
    };
};
/** R3 — exactly budget/balanced/resilient, no more, no fewer. */
export const exactlyThreeTiers = (result) => {
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
export const ALL_PROPERTIES = [
    exactlyThreeTiers,
    everyTierCoversAllBaselines,
    allEdgesPayloadLabeled,
    onDemandDisclaimerPresent,
    noBannedServices,
];
/** Run every property and aggregate; `ok` is true only if all pass. */
export function runAllProperties(result) {
    const results = ALL_PROPERTIES.map((p) => p(result));
    return { ok: results.every((r) => r.ok), results };
}
//# sourceMappingURL=properties.js.map