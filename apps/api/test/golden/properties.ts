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
  | "queuesAreResilient"
  | "computeMatchesDecision"
  | "datastoreMatchesDecision"
  | "graphHasNoDanglingEdges"
  | "primaryDatastoreReachable";

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

// SNS (and the "message"/"notification" keywords) match BOTH a real work queue/topic
// AND the observability alerting path (CloudWatch alarm → SNS → email/Slack/PagerDuty).
// The latter carries no business payload and needs no DLQ/idempotency, so a node that
// is clearly an alerting sink must NOT be counted as a work queue — otherwise a clean
// serverless design (Lambda + DynamoDB + an SNS *alarm notifier*) is falsely flagged.
const ALERT_SINK_ROLE_KEYWORDS = [
  "alarm",
  "alert",
  "on-call",
  "on call",
  "oncall",
  "notifier",
  "notification",
  "pagerduty",
  "page ",
  "ops notification",
  // Alerting CHANNELS — an SNS/notification node delivering to one of these is an
  // observability sink (CloudWatch alarm → SNS → human), not a work queue. Without
  // these, a clean design using Slack/webhook/email alerting was falsely flagged.
  "slack",
  "webhook",
  "incident",
  "email",
  "sms",
  "teams",
  "chime",
  "opsgenie",
] as const;

/**
 * True when a node matches a queue keyword but is NOT a work queue that needs
 * DLQ + idempotency. Two non-queue uses of these keywords:
 *   1. Alert sink — an SNS/notification node whose role is an alarm/on-call path
 *      (CloudWatch alarm → SNS → human); no business payload.
 *   2. Scheduler — EventBridge *Scheduler* / a cron trigger fires a job on a timer;
 *      it's a clock, not an at-least-once work queue (the JOB it triggers may need a
 *      DLQ, and that job's own SQS node would still be checked).
 */
function isNonQueueNode(awsService: string, role: string): boolean {
  const svc = awsService.toLowerCase();
  const r = role.toLowerCase();
  const isPubSubNotifier = svc.includes("sns") || svc.includes("notification");
  // An SNS *subscription* node is a delivery endpoint (email/Slack/HTTP), never a
  // work queue — regardless of how its role is phrased.
  if (isPubSubNotifier && svc.includes("subscription")) return true;
  if (isPubSubNotifier && ALERT_SINK_ROLE_KEYWORDS.some((kw) => r.includes(kw))) return true;
  // "EventBridge Scheduler" / "... scheduler" / "cron" trigger — a timer, not a queue.
  if (`${svc} ${r}`.includes("scheduler") || r.includes("cron")) return true;
  return false;
}

function tierHasQueue(tier: Tier): boolean {
  return tier.nodes.some((n) => {
    if (isNonQueueNode(n.awsService, n.role)) return false;
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

// --- Compute coherence (the graph must agree with its own decision) ---------
//
// The single most damaging incoherence we've seen: a keyDecision commits to a
// compute model ("chosen: Lambda behind API Gateway") while the tier's actual
// NODES run the opposite (EC2 + ALB). The downstream cost engine prices the
// NODES, so a serverless RECOMMENDATION silently bills an always-on EC2/ALB/NAT
// stack — the design contradicts itself and the cost is wrong as a consequence.
//
// We detect a compute decision by its `decision`/`chosen` text, classify what it
// committed to (serverless vs always-on compute), then require the tiers' compute
// nodes to not contradict it. This is intentionally one-directional and
// conservative: it fires only on a CLEAR contradiction (a serverless decision but
// VM/container compute present, or vice-versa), never on ambiguity, so it stays a
// real regression signal rather than a flaky stylistic nag.

/** A keyDecision is "about compute" if it names the compute/runtime choice. */
const COMPUTE_DECISION_KEYWORDS = ["compute", "runtime", "api tier", "application tier", "hosting"] as const;

/** Node services that ARE serverless compute. */
const SERVERLESS_COMPUTE = ["lambda"] as const;
/** Node services that are ALWAYS-ON compute (a VM or a container/load-balancer pair). */
const ALWAYSON_COMPUTE = ["ec2", "fargate", "ecs", "eks", "elastic beanstalk", "app runner"] as const;

/** What a compute decision committed to, read from its `chosen` text. */
type ComputeChoice = "serverless" | "alwayson" | "unknown";

function classifyChosenCompute(chosen: string): ComputeChoice {
  const c = chosen.toLowerCase();
  const saysServerless = c.includes("serverless") || c.includes("lambda");
  const saysAlwayson = ALWAYSON_COMPUTE.some((kw) => c.includes(kw)) || c.includes("container") || c.includes("auto scaling");
  // A decision that names both (e.g. "Lambda, with Fargate for X") is mixed → don't judge.
  if (saysServerless && !saysAlwayson) return "serverless";
  if (saysAlwayson && !saysServerless) return "alwayson";
  return "unknown";
}

function tierComputeKinds(tier: Tier): { serverless: string[]; alwayson: string[] } {
  const serverless: string[] = [];
  const alwayson: string[] = [];
  for (const n of tier.nodes) {
    const surface = `${n.awsService} ${n.role}`.toLowerCase();
    if (SERVERLESS_COMPUTE.some((kw) => new RegExp(`\\b${kw}\\b`).test(surface))) serverless.push(n.awsService);
    if (ALWAYSON_COMPUTE.some((kw) => new RegExp(`\\b${kw}\\b`).test(surface))) alwayson.push(n.awsService);
  }
  return { serverless, alwayson };
}

/**
 * Coherence: a stated compute decision must not be contradicted by the tiers'
 * compute nodes. A "serverless" decision with an always-on compute node present
 * (or an "alwayson" decision with no always-on compute anywhere) is a hard fail —
 * that's the self-contradiction that makes the cost wrong. Designs with no compute
 * decision, or a mixed/unknown one, pass (nothing to contradict).
 */
export const computeMatchesDecision: Property = (result) => {
  const computeDecisions = result.keyDecisions.filter((d) =>
    COMPUTE_DECISION_KEYWORDS.some((kw) => `${d.decision} ${d.chosen}`.toLowerCase().includes(kw)),
  );
  const offenders: string[] = [];
  for (const d of computeDecisions) {
    const choice = classifyChosenCompute(d.chosen);
    if (choice === "unknown") continue;
    for (const tier of result.tiers) {
      const kinds = tierComputeKinds(tier);
      if (choice === "serverless" && kinds.alwayson.length > 0) {
        offenders.push(
          `${tier.name}: decision chose serverless ("${d.chosen}") but tier runs always-on compute [${kinds.alwayson.join(", ")}]`,
        );
      }
      if (choice === "alwayson" && kinds.alwayson.length === 0) {
        offenders.push(
          `${tier.name}: decision chose always-on compute ("${d.chosen}") but tier has no always-on compute node`,
        );
      }
    }
  }
  return {
    name: "computeMatchesDecision",
    ok: offenders.length === 0,
    reason:
      offenders.length === 0
        ? "compute nodes are consistent with the stated compute decision"
        : offenders.join("; "),
  };
};

// --- Datastore coherence (the graph must agree with its datastore decision) --
//
// Same failure class as compute, second-most-damaging: a datastore keyDecision
// commits to a managed/serverless store ("DynamoDB on-demand", "Aurora Serverless")
// while a tier's nodes run a VPC-bound RDS/Aurora-provisioned instance — or names a
// store that is then absent from the graph entirely. A VPC-bound store drags in the
// private-subnet + NAT-gateway floor (~$33/mo always-on), so a "serverless,
// scale-to-zero" datastore recommendation that's actually drawn as RDS silently
// bills NAT. Conservative, like computeMatchesDecision: fires only on a clear
// contradiction, passes on mixed/unknown.

/** A keyDecision is "about the datastore" if it names the datastore/database choice. */
const DATASTORE_DECISION_KEYWORDS = ["datastore", "database", "data store", "primary data", "persistence"] as const;

/** Stores that are VPC-bound (force a private subnet → NAT): always-on DB engines. */
const VPC_BOUND_STORES = ["rds", "elasticache", "opensearch", "redshift", "neptune", "documentdb", "memorydb"] as const;
/** Stores that are managed/serverless and need NO VPC/NAT. */
const SERVERLESS_STORES = ["dynamodb", "s3"] as const;

/** What a datastore decision committed to, read from its `chosen` text. */
type StoreChoice = "serverless" | "vpcbound" | "unknown";

function classifyChosenStore(chosen: string): StoreChoice {
  const c = chosen.toLowerCase();
  // "Aurora Serverless" is serverless-shaped (scale-to-zero, no instance to keep warm);
  // plain "Aurora"/"RDS" is a VPC-bound always-on instance. Disambiguate on "serverless".
  const saysServerless =
    SERVERLESS_STORES.some((kw) => c.includes(kw)) || (c.includes("aurora") && c.includes("serverless"));
  const saysVpcBound =
    VPC_BOUND_STORES.some((kw) => c.includes(kw)) || (c.includes("aurora") && !c.includes("serverless"));
  if (saysServerless && !saysVpcBound) return "serverless";
  if (saysVpcBound && !saysServerless) return "vpcbound";
  return "unknown";
}

function tierStoreKinds(tier: Tier): { serverless: string[]; vpcbound: string[] } {
  const serverless: string[] = [];
  const vpcbound: string[] = [];
  for (const n of tier.nodes) {
    // Classify what a node IS by its SERVICE name only, never the role prose — a role
    // like "distributed trace (app→Aurora→LLM)" on an X-Ray node names Aurora to
    // describe a data flow, but the node is not a store. Keying on awsService keeps
    // "is this node a VPC-bound store?" honest. Aurora Serverless v2 keeps the
    // "serverless" qualifier where it appears in the service label.
    const svc = n.awsService.toLowerCase();
    const auroraServerless = svc.includes("aurora") && svc.includes("serverless");
    if (SERVERLESS_STORES.some((kw) => new RegExp(`\\b${kw}\\b`).test(svc)) || auroraServerless) {
      serverless.push(n.awsService);
    }
    if (VPC_BOUND_STORES.some((kw) => new RegExp(`\\b${kw}\\b`).test(svc))) vpcbound.push(n.awsService);
    else if (svc.includes("aurora") && !svc.includes("serverless")) vpcbound.push(n.awsService);
  }
  return { serverless, vpcbound };
}

/**
 * Coherence: a stated datastore decision must not be contradicted by the tiers'
 * datastore nodes. A "serverless" datastore decision with a VPC-bound store node
 * present (the case that secretly adds NAT), or a "vpcbound" decision with no such
 * store anywhere, is a hard fail. Mixed/unknown decisions pass.
 */
export const datastoreMatchesDecision: Property = (result) => {
  const storeDecisions = result.keyDecisions.filter((d) =>
    DATASTORE_DECISION_KEYWORDS.some((kw) => `${d.decision} ${d.chosen}`.toLowerCase().includes(kw)),
  );
  const offenders: string[] = [];
  for (const d of storeDecisions) {
    const choice = classifyChosenStore(d.chosen);
    if (choice === "unknown") continue;
    for (const tier of result.tiers) {
      const kinds = tierStoreKinds(tier);
      if (choice === "serverless" && kinds.vpcbound.length > 0) {
        offenders.push(
          `${tier.name}: decision chose a serverless datastore ("${d.chosen}") but tier runs a VPC-bound store [${kinds.vpcbound.join(", ")}] (forces NAT)`,
        );
      }
      if (choice === "vpcbound" && kinds.vpcbound.length === 0) {
        offenders.push(
          `${tier.name}: decision chose a VPC-bound datastore ("${d.chosen}") but tier has no such store node`,
        );
      }
    }
  }
  return {
    name: "datastoreMatchesDecision",
    ok: offenders.length === 0,
    reason:
      offenders.length === 0
        ? "datastore nodes are consistent with the stated datastore decision"
        : offenders.join("; "),
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

// --- Completeness critic (R-completeness) -----------------------------------
//
// Structural completeness the model must satisfy regardless of domain. These
// matter MORE since tier-delta emission: balanced/resilient are reconstructed from
// deltas, so a delta that references a renamed/removed node id would otherwise
// produce a silently-broken graph. Both checks are high-confidence (no realistic
// false positive), so they gate launch.

// PRIMARY data stores only (OLTP / cache / search) — deliberately EXCLUDES S3,
// which is often a legitimately-unconnected asset/audit-log sink. A primary store
// with no edge is always an incomplete design (you can't read or write it).
const PRIMARY_DATASTORE_KEYWORDS = [
  "dynamodb", "rds", "aurora", "elasticache", "redis", "memcached",
  "opensearch", "elasticsearch", "documentdb", "neptune", "redshift", "timestream",
] as const;

function isPrimaryDatastore(awsService: string, role: string): boolean {
  const s = `${awsService} ${role}`.toLowerCase();
  return PRIMARY_DATASTORE_KEYWORDS.some((kw) => s.includes(kw));
}

/** Every edge endpoint must be a real node `id` in that tier (or the literal
 *  "client"). A dangling edge is always a bug — and the canonical failure mode of a
 *  bad tier-delta (an addEdge referencing a node id that was renamed or removed). */
export const graphHasNoDanglingEdges: Property = (result) => {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    const ids = new Set(tier.nodes.map((n) => n.id));
    ids.add("client");
    tier.edges.forEach((e, i) => {
      if (!ids.has(e.from)) offenders.push(`${tier.name}:edge[${i}] from unknown '${e.from}'`);
      if (!ids.has(e.to)) offenders.push(`${tier.name}:edge[${i}] to unknown '${e.to}'`);
    });
  }
  return {
    name: "graphHasNoDanglingEdges",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every edge references a real node" : offenders.join("; "),
  };
};

/** A primary datastore (DynamoDB/RDS/Aurora/cache/search) must be touched by at
 *  least one edge — an unwired primary store is an incomplete design. */
export const primaryDatastoreReachable: Property = (result) => {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    const wired = new Set<string>();
    for (const e of tier.edges) {
      wired.add(e.from);
      wired.add(e.to);
    }
    for (const n of tier.nodes) {
      if (isPrimaryDatastore(n.awsService, n.role) && !wired.has(n.id)) {
        offenders.push(`${tier.name}: datastore '${n.id}' (${n.awsService}) has no edge`);
      }
    }
  }
  return {
    name: "primaryDatastoreReachable",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every primary datastore is wired into the graph" : offenders.join("; "),
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
  computeMatchesDecision,
  datastoreMatchesDecision,
  graphHasNoDanglingEdges,
  primaryDatastoreReachable,
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
