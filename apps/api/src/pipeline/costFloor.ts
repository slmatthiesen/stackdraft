/**
 * Idle-floor analysis (cost-honest Budget — docs/plans/2026-06-29-003).
 *
 * The Budget tier's job is "cheapest CORRECT" — so the metric that matters is the
 * ALWAYS-ON floor: what the design bills at *zero traffic*. Usage-scaled serverless
 * (Lambda, DynamoDB on-demand, S3, API Gateway, SQS, SNS, CloudFront, EventBridge)
 * scales to ~$0 idle and is excluded; the floor is the sum of the minimum monthly
 * cost of the services that bill 24/7 whether or not a request arrives.
 *
 * Pure + deterministic, like completeness.ts — so it can gate the eval AND ride a
 * telemetry line. The gate that consumes it lives in test/golden/properties.ts.
 */
import type { ArchitectureResult, Tier } from "../schema/architecture.js";

/**
 * Services that bill on a 24/7 floor regardless of traffic. Aurora Serverless v2 is
 * included deliberately — it scales DOWN but not to zero (a ~0.5-ACU minimum floor).
 * NOT here (usage-based, ~$0 idle): Lambda, DynamoDB on-demand, S3, API Gateway, SQS,
 * SNS, CloudFront, EventBridge, Step Functions.
 */
export const ALWAYS_ON_SERVICE_KEYWORDS = [
  "nat gateway",
  "load balancer", "alb", "nlb", "elb",
  "rds", "aurora",
  "elasticache", "redis", "memcached", "memorydb",
  "fargate", "ecs", "ec2", "eks", "app runner",
  "opensearch", "elasticsearch", "redshift", "msk", "kafka", "documentdb", "neptune",
] as const;

export function isAlwaysOnService(service: string): boolean {
  const s = service.toLowerCase();
  return ALWAYS_ON_SERVICE_KEYWORDS.some((kw) => s.includes(kw));
}

/** Lowest dollar figure in an estimate range like "$32.85–$65.70/mo" → 32.85. */
function parseLowUsd(estimateRange: string): number {
  const m = estimateRange.match(/([0-9]+\.?[0-9]*)/);
  return m ? Number.parseFloat(m[1]!) : 0;
}

export interface IdleFloor {
  /** Sum of the minimum monthly cost of the tier's always-on services. */
  usd: number;
  /** Distinct always-on services contributing to the floor (the "stack"). */
  services: string[];
}

/** A tier's idle floor: the minimum it bills at zero traffic. Serverless tiers ≈ $0. */
export function tierIdleFloor(tier: Tier): IdleFloor {
  let usd = 0;
  const services = new Set<string>();
  for (const cd of tier.costDrivers) {
    if (isAlwaysOnService(cd.service)) {
      usd += parseLowUsd(cd.estimateRange);
      services.add(cd.service);
    }
  }
  return { usd: Math.round(usd * 100) / 100, services: [...services] };
}

/** The budget tier's idle floor — the headline number for the cost-honest gate. */
export function budgetIdleFloor(result: ArchitectureResult): IdleFloor {
  const budget = result.tiers.find((t) => t.name === "budget");
  return budget ? tierIdleFloor(budget) : { usd: 0, services: [] };
}
