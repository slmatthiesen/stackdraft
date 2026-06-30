/**
 * Test fixtures for the golden harness (U15).
 *
 * `goodArchitecture()` is the single most-reused fixture: a realistic,
 * schema-valid three-tier design where every property holds (all 8 baselines on
 * every tier, every edge payload-labeled, the list-price disclaimer present, no
 * banned services). `badArchitecture()` is the same design with the audit/logging
 * baseline stripped from the budget tier — a realistic regression that must trip
 * the property gate so the runner proves it detects drops, not just green paths.
 *
 * No network or paid calls: `fakeProvider` returns a canned result for any prompt.
 */
import type {
  GenerateOptions,
  GroundedPrompt,
  LlmProvider,
  ProviderResult,
  Usage,
} from "../../src/llm/provider.js";
import type {
  ArchitectureResult,
  Clarification,
  Tier,
  TierName,
} from "../../src/schema/architecture.js";
import { ArchitectureResultSchema, TIER_NAMES } from "../../src/schema/architecture.js";

const USAGE: Usage = { inputTokens: 1500, outputTokens: 1200, cacheReadTokens: 4096, cacheWriteTokens: 0 };

interface TierOptions {
  /**
   * When false, the queue node stays but its DLQ + idempotency TAGS are dropped —
   * a regression `queuesAreResilient` must catch (at-least-once delivery without an
   * idempotent consumer / a DLQ is a poison-message footgun). LEANER SHAPE: the
   * resilience signal now lives in node `security` tags, not setup-step prose.
   */
  includeQueueResilience?: boolean;
}

/**
 * The safe-by-default floor, stated ONCE (LEANER SHAPE): one short line per
 * baseline, engineered to evidence all eight via the properties.ts keyword
 * vocabulary. `includeAuditLogging:false` drops the audit/access-logging line so
 * `securityFloorCoversAllBaselines` flips to fail.
 */
function securityFloor(opts: { includeAuditLogging?: boolean } = {}): string[] {
  const floor = [
    "Encryption at rest with KMS / SSE across S3, DynamoDB, and EBS.",
    "TLS enforced in transit; HTTPS only, plaintext denied.",
    "Least-privilege IAM roles, no wildcard actions, no long-lived keys.",
    "S3 account-level Block Public Access on; no bucket can be made public.",
    "Data tier in private subnets with no public route.",
    "Credentials in AWS Secrets Manager / SSM Parameter Store.",
    "Edge protection: CloudFront + AWS WAF + Shield Standard.",
  ];
  if (opts.includeAuditLogging !== false) {
    floor.push("CloudTrail + access logging (S3, CloudFront, ALB) + VPC Flow Logs enabled.");
  }
  return floor;
}

function makeTier(name: TierName, opts: TierOptions = {}): Tier {
  const queueResilient = opts.includeQueueResilience !== false;
  return {
    name,
    summary: `${name} tier: safe-by-default serverless, varying only on the robustness axis.`,
    // LEANER SHAPE: nodes are structure — service + ≤4-word role + short security
    // TAGS, no prose. Queue resilience is a TAG on the queue ("DLQ") and its
    // consumer ("idempotent consumer"), not setup-step narration.
    nodes: [
      { id: "cdn", awsService: "CloudFront", role: "edge CDN + cache", security: ["WAF", "TLS 1.3", "Shield Standard"] },
      { id: "api", awsService: "API Gateway", role: "REST front door", security: ["TLS", "throttling", "least-priv role"] },
      { id: "fn", awsService: "Lambda", role: "business logic", security: ["least-priv role", "no long-lived keys"] },
      { id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["KMS at rest", "private subnet", "least-priv role"] },
      { id: "assets", awsService: "S3", role: "assets + uploads", security: ["block public access", "SSE-KMS", "TLS-only policy"] },
      {
        id: "queue",
        awsService: "SQS",
        role: "upload job buffer",
        security: queueResilient
          ? ["SSE-KMS", "TLS", "DLQ", "visibility-timeout retries"]
          : ["SSE-KMS", "TLS"],
      },
      {
        id: "worker",
        awsService: "Lambda",
        role: "thumbnail worker",
        security: queueResilient
          ? ["least-priv role", "idempotent consumer", "no long-lived keys"]
          : ["least-priv role", "no long-lived keys"],
      },
    ],
    edges: [
      { from: "client", to: "cdn", payload: "HTTPS page and API request", protocol: "HTTPS" },
      { from: "cdn", to: "api", payload: "Cached or forwarded JSON request", protocol: "HTTPS" },
      { from: "api", to: "fn", payload: "Invocation event (JSON)", protocol: "AWS SDK" },
      { from: "fn", to: "db", payload: "Item read/write", protocol: "HTTPS" },
      { from: "fn", to: "assets", payload: "Object get/put", protocol: "HTTPS" },
      { from: "fn", to: "queue", payload: "Upload-processing job message", protocol: "SQS" },
      { from: "queue", to: "worker", payload: "Job message (at-least-once delivery)", protocol: "SQS" },
    ],
    costDrivers: [
      { service: "API Gateway", unit: "per 1k requests", estimateRange: "$0.0035–$0.01", note: "" },
      { service: "Lambda", unit: "per 1k requests + $/GB-s", estimateRange: "$0.02–$0.30", note: "" },
      { service: "DynamoDB", unit: "per 1k RRU/WRU", estimateRange: "$0.13–$0.80", note: "" },
    ],
    // LEANER SHAPE: delta = what THIS tier adds/changes vs the others (robustness,
    // incl. burst handling). Budget states the baseline. No DLQ/idempotency words
    // here — that resilience lives in the node tags so the gate stays real.
    delta:
      name === "budget"
        ? ["baseline: single-AZ, DynamoDB on-demand, Lambda reserved concurrency for burst"]
        : name === "balanced"
          ? ["+ multi-AZ", "+ provisioned concurrency on hot paths", "+ CloudWatch dashboards + tracing"]
          : ["+ read replicas", "+ cross-region failover", "+ EventBridge fan-out", "+ SLO alarms"],
    tradeoffs:
      name === "budget"
        ? ["vs balanced: single-AZ, on-demand only — cheaper, lower availability", "vs resilient: no multi-AZ replication"]
        : name === "balanced"
          ? ["vs budget: multi-AZ adds availability at higher cost", "vs resilient: no cross-region failover"]
          : ["vs balanced: adds read replicas and multi-AZ for resilience", "vs budget: highest cost, highest availability"],
  };
}

/**
 * A schema-valid known-GOOD result. Validated against the schema at module load
 * so a fixture drift surfaces immediately rather than as a confusing test failure.
 */
export function goodArchitecture(): ArchitectureResult {
  return {
    assumptions: [
      "Single default region us-east-1.",
      "Cost ranges are on-demand list prices (us-east-1), excluding Free Tier, Savings Plans, and Reserved discounts.",
      "Moderate, bursty traffic unless stated otherwise.",
    ],
    clarificationsUsed: [],
    securityFloor: securityFloor(),
    tiers: TIER_NAMES.map((name) => makeTier(name)),
    recommendedTier: "balanced",
    recommendationRationale:
      "Balanced ships multi-AZ availability for the stated moderate-but-bursty traffic without the cross-region cost of resilient; it scales to the next order of magnitude by configuration.",
    keyDecisions: [
      {
        decision: "Compute model for the API tier",
        chosen: "Lambda behind API Gateway",
        alternativesConsidered: ["Fargate service", "EC2 Auto Scaling group"],
        rationale:
          "Serverless removes capacity management and scales to zero (cost optimization + operational excellence); the bursty, request/response shape doesn't justify always-on containers.",
      },
      {
        decision: "Decoupling upload processing from the request path",
        chosen: "SQS queue with an idempotent Lambda consumer and a DLQ",
        alternativesConsidered: ["Synchronous in-request processing", "Kinesis stream"],
        rationale:
          "Queue-based load leveling protects the request path and limited downstream capacity under bursts (reliability + performance efficiency); ordering isn't required so SQS beats Kinesis.",
      },
      {
        decision: "Primary datastore",
        chosen: "DynamoDB on-demand",
        alternativesConsidered: ["RDS (Postgres)", "Aurora Serverless v2"],
        rationale:
          "On-demand absorbs short spikes with no capacity planning and no NAT cost (cost optimization + reliability); the access pattern is key-value, not relational.",
      },
    ],
  };
}

/**
 * A known-BAD result with TWO realistic regressions the gate must catch:
 *   1. the GLOBAL securityFloor drops the audit/access-logging baseline
 *      (`securityFloorCoversAllBaselines` flips to fail), and
 *   2. every tier keeps its SQS node but drops the DLQ + idempotency TAGS
 *      (`queuesAreResilient` flips to fail) — at-least-once delivery with no
 *      idempotent consumer / DLQ is the classic poison-message footgun.
 * Either alone collapses the aggregate; together they prove the new gate fires.
 */
export function badArchitecture(): ArchitectureResult {
  return {
    ...goodArchitecture(),
    securityFloor: securityFloor({ includeAuditLogging: false }),
    tiers: TIER_NAMES.map((name) => makeTier(name, { includeQueueResilience: false })),
  };
}

/**
 * A known-BAD result reproducing the real "happy-hour site" incoherence: the
 * compute keyDecision commits to serverless ("Lambda behind API Gateway") while
 * every tier's graph actually runs an always-on EC2 + ALB stack. The cost engine
 * prices the NODES, so this is exactly the bug where a serverless recommendation
 * silently bills EC2/ALB/NAT. `computeMatchesDecision` must flip to fail; the
 * other properties still pass (the contradiction is the only defect), proving the
 * new gate isolates THIS class of error.
 */
export function incoherentComputeArchitecture(): ArchitectureResult {
  const base = goodArchitecture();
  // Swap the serverless API Lambda ("fn") for an always-on EC2 + ALB stack, leaving
  // everything else (incl. the "Lambda behind API Gateway" keyDecision) intact, so
  // the ONLY broken invariant is compute↔decision coherence.
  const breakCompute = (tier: Tier): Tier => ({
    ...tier,
    nodes: [
      ...tier.nodes.map((n) =>
        n.id === "fn"
          ? { id: "fn", awsService: "EC2", role: "API server", security: ["private subnet", "least-priv role"] }
          : n,
      ),
      { id: "alb", awsService: "ALB", role: "load balancer", security: ["TLS", "WAF"] },
    ],
    // Wire the ALB in front of the EC2 (front door → ALB → API server) so the ONLY
    // broken invariant stays compute↔decision coherence — an unwired ALB would be a
    // second, unintended defect (now caught by graphHasNoOrphanNodes).
    edges: [
      ...tier.edges,
      { from: "api", to: "alb", payload: "Forwarded HTTP request", protocol: "HTTPS" },
      { from: "alb", to: "fn", payload: "Load-balanced request", protocol: "HTTPS" },
    ],
  });
  return { ...base, tiers: base.tiers.map(breakCompute) };
}

/**
 * A known-BAD result reproducing the datastore half of the same bug: the
 * "Primary datastore" keyDecision still commits to serverless DynamoDB, but every
 * tier's store node is a VPC-bound RDS Postgres instance — which silently drags in
 * the private-subnet + NAT-gateway floor the serverless choice was meant to avoid.
 * `datastoreMatchesDecision` must flip to fail while the rest stay green.
 */
export function incoherentDatastoreArchitecture(): ArchitectureResult {
  const base = goodArchitecture();
  const swapToRds = (tier: Tier): Tier => ({
    ...tier,
    nodes: tier.nodes.map((n) =>
      n.id === "db"
        ? { id: "db", awsService: "RDS", role: "Postgres datastore", security: ["private subnet", "KMS at rest", "least-priv role"] }
        : n,
    ),
  });
  return { ...base, tiers: base.tiers.map(swapToRds) };
}

/**
 * A clean serverless result whose ONLY queue-keyword node is an SNS *alarm notifier*
 * (the CloudWatch alarm → SNS → email path), with NO work queue and NO DLQ/idempotency
 * tags anywhere. Mirrors the real curated url-shortener. `queuesAreResilient` must PASS
 * (the alert sink is not a work queue), proving the alerting path isn't mis-flagged.
 */
export function alertOnlySnsArchitecture(): ArchitectureResult {
  const base = goodArchitecture();
  const serverlessNoQueue = (tier: Tier): Tier => ({
    ...tier,
    // Lambda + DynamoDB + an SNS alarm notifier; drop the SQS work queue + its worker.
    nodes: [
      { id: "cdn", awsService: "CloudFront", role: "edge CDN + cache", security: ["WAF", "TLS 1.3"] },
      { id: "api", awsService: "API Gateway", role: "REST front door", security: ["TLS", "throttling"] },
      { id: "fn", awsService: "Lambda", role: "business logic", security: ["least-priv role"] },
      { id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["KMS at rest"] },
      { id: "alarm", awsService: "SNS", role: "alarm notifier", security: ["TLS"] },
    ],
    edges: [
      { from: "client", to: "cdn", payload: "HTTPS request", protocol: "HTTPS" },
      { from: "cdn", to: "api", payload: "Forwarded request", protocol: "HTTPS" },
      { from: "api", to: "fn", payload: "Invocation event", protocol: "AWS SDK" },
      { from: "fn", to: "db", payload: "Item read/write", protocol: "HTTPS" },
      { from: "alarm", to: "fn", payload: "Alarm state notification", protocol: "SNS" },
    ],
    delta: tier.name === "budget" ? ["baseline: single-AZ, DynamoDB on-demand"] : ["+ multi-AZ", "+ dashboards"],
  });
  return { ...base, tiers: base.tiers.map(serverlessNoQueue) };
}

// Validate the good fixture once at load — a drift here is a fixture bug.
ArchitectureResultSchema.parse(goodArchitecture());
ArchitectureResultSchema.parse(incoherentComputeArchitecture());
ArchitectureResultSchema.parse(incoherentDatastoreArchitecture());
ArchitectureResultSchema.parse(alertOnlySnsArchitecture());

export interface FakeProvider {
  provider: LlmProvider;
  generateCalls: number;
}

/** A provider that returns `arch` for any prompt — no network, no paid calls. */
export function fakeProvider(arch: ArchitectureResult): FakeProvider {
  const state = { generateCalls: 0 };
  const provider: LlmProvider = {
    async generate(_prompt: GroundedPrompt, _opts?: GenerateOptions): Promise<ProviderResult<ArchitectureResult>> {
      state.generateCalls += 1;
      return { result: arch, usage: USAGE };
    },
    async clarify(): Promise<ProviderResult<Clarification>> {
      return { result: { needsClarification: false, questions: [] }, usage: USAGE };
    },
    async generateConfig(): Promise<ProviderResult<string>> {
      return { result: 'resource "aws_lambda_function" "api" {}', usage: USAGE };
    },
    async countTokens(text: string): Promise<number> {
      return text.length;
    },
  };
  return {
    provider,
    get generateCalls() {
      return state.generateCalls;
    },
  };
}
