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
  /** When false, the audit/access-logging baseline is omitted (regression). */
  includeAuditLogging?: boolean;
}

/**
 * Security notes engineered to evidence all eight baselines via keyword match
 * (properties.ts vocabulary). Realistic prose, but every baseline is traceable.
 */
function securityNotes(name: TierName, opts: TierOptions): string[] {
  const notes = [
    "All data encrypted at rest with KMS / SSE (S3 SSE-KMS, DynamoDB and EBS encryption).",
    "TLS enforced in transit; HTTPS only, plaintext denied via aws:SecureTransport.",
    "Least-privilege IAM: scoped per-service roles, no wildcard actions, no long-lived keys.",
    "S3 account-level Block Public Access is on; no bucket can be made public.",
    "Data tier (DynamoDB/RDS) lives in private subnets with no public route; reachable only from the app tier.",
    "Credentials and connection strings live in AWS Secrets Manager / SSM Parameter Store.",
    "Edge protection: CloudFront + AWS WAF managed and rate-based rules; Shield Standard applies automatically.",
  ];
  if (opts.includeAuditLogging !== false) {
    notes.push("CloudTrail plus access logging (S3, CloudFront, ALB) and VPC Flow Logs are enabled.");
  }
  if (name === "budget") {
    notes.push("Budget is the MINIMUM SAFE COST: the full security floor above is kept — never relaxed for price.");
  }
  return notes;
}

function makeTier(name: TierName, opts: TierOptions = {}): Tier {
  return {
    name,
    summary: `${name} tier: a safe-by-default serverless design varying only on the robustness axis.`,
    nodes: [
      {
        id: "cdn",
        awsService: "CloudFront",
        purpose: "Edge CDN and cache fronting the API and static assets",
        security: ["AWS WAF managed + rate-based rules", "TLS 1.3", "Shield Standard"],
        scaling: { burst: "CloudFront caching offloads read-heavy GETs", trivialInCore: true },
      },
      {
        id: "api",
        awsService: "API Gateway",
        purpose: "REST front door with request validation",
        security: ["TLS 1.2+", "request throttling", "least-privilege IAM role"],
        scaling: { burst: "API Gateway throttling caps protect downstream", trivialInCore: true },
      },
      {
        id: "fn",
        awsService: "Lambda",
        purpose: "Business logic compute",
        security: ["least-privilege IAM execution role", "no long-lived keys"],
        scaling: { burst: "Lambda reserved concurrency bounds blast radius", trivialInCore: true },
      },
      {
        id: "db",
        awsService: "DynamoDB",
        purpose: "Primary datastore in a private subnet",
        security: ["KMS encryption at rest", "private VPC endpoint", "least-privilege IAM role"],
        scaling: { burst: "DynamoDB on-demand absorbs read/write spikes", trivialInCore: true },
      },
      {
        id: "assets",
        awsService: "S3",
        purpose: "Static assets and user uploads",
        security: ["S3 Block Public Access", "SSE-KMS at rest", "TLS-only bucket policy"],
        scaling: { burst: "S3 scales automatically", trivialInCore: true },
      },
    ],
    edges: [
      { from: "client", to: "cdn", payload: "HTTPS page and API request", protocol: "HTTPS" },
      { from: "cdn", to: "api", payload: "Cached or forwarded JSON request", protocol: "HTTPS" },
      { from: "api", to: "fn", payload: "Invocation event (JSON)", protocol: "AWS SDK" },
      { from: "fn", to: "db", payload: "Item read/write", protocol: "HTTPS" },
      { from: "fn", to: "assets", payload: "Object get/put", protocol: "HTTPS" },
    ],
    setupSteps: [
      "Create the DynamoDB table with encryption and on-demand capacity.",
      "Deploy the Lambda function with a scoped execution role.",
      "Create the API Gateway REST API with throttling and TLS.",
      "Put CloudFront + WAF in front and enable logging.",
    ],
    costDrivers: [
      { service: "API Gateway", unit: "per 1k requests", estimateRange: "$0.0035–$0.01", note: "" },
      { service: "Lambda", unit: "per 1k requests + $/GB-s", estimateRange: "$0.02–$0.30", note: "" },
      { service: "DynamoDB", unit: "per 1k RRU/WRU", estimateRange: "$0.13–$0.80", note: "" },
      {
        service: "NAT Gateway",
        unit: "$0.045/GB processed + $/hr",
        estimateRange: "$32–$70/mo",
        note: "required by the private-subnet default",
      },
      { service: "Data transfer", unit: "$/GB egress", estimateRange: "$0.05–$0.09/GB", note: "internet egress" },
    ],
    burstHandling: [
      "built-in: DynamoDB on-demand, API Gateway throttling, CloudFront caching, Lambda reserved concurrency",
      "optional: SQS buffering in front of the worker for very large write bursts",
      "note: NAT-gateway processing plus internet egress is a recurring cost of the private-subnet default",
    ],
    securityNotes: securityNotes(name, opts),
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
    tiers: TIER_NAMES.map((name) => makeTier(name)),
  };
}

/**
 * A known-BAD result: the budget tier drops the audit/access-logging baseline.
 * `everyTierCoversAllBaselines` must flip to fail (and the aggregate pass-rate
 * must drop), proving the regression detector works.
 */
export function badArchitecture(): ArchitectureResult {
  return {
    ...goodArchitecture(),
    tiers: TIER_NAMES.map((name) => makeTier(name, { includeAuditLogging: name !== "budget" })),
  };
}

// Validate the good fixture once at load — a drift here is a fixture bug.
ArchitectureResultSchema.parse(goodArchitecture());

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
