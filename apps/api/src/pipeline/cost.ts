/**
 * Deterministic cost estimator (U7 / R6 / KTD6).
 *
 * Fills each tier's `costDrivers[].estimateRange` from the cached `PricingStore`
 * — the LLM is NEVER asked for dollar figures (KTD6). Given the model's typed
 * graph (services per tier) plus an assumed monthly-volume band, this maps every
 * priceable service to a $ RANGE expressed in that service's NATIVE unit, and
 * forcibly surfaces the data-transfer / NAT-gateway cost that the private-subnet
 * security default (R7 #5) imposes — the single most common budget surprise.
 *
 * Why ranges, never points: AWS list prices are exact but real spend depends on
 * volume we don't know, so a false-precision point estimate would mislead. We
 * apply a deliberately wide low→high monthly-volume band per native unit and
 * present "$x–$y/mo". The bands + formatter are exported so callers/tests assert
 * exact ranges against the same numbers rather than hard-coding drift-prone
 * strings.
 *
 * Why native units (not forced per-1,000): request-priced services have a real
 * per-1k unit; capacity/time-priced (EC2/RDS/ElastiCache/ALB/Fargate) and
 * per-MAU (Cognito) services do not, so they keep $/hr, $/GB-mo, etc. and carry
 * an explicit assumed-throughput note. Data transfer (internet egress, cross-AZ,
 * NAT processed + hourly) is a first-class unit.
 */
import pricingFacts from "@stackdraft/kb/pricing-facts.seed.json" with { type: "json" };
import type { PricingFact } from "@stackdraft/kb";

import type { ArchitectureResult, CostDriver, Tier } from "../schema/architecture.js";
import type { PriceRecord, PricingStore } from "../store/types.js";

/** Assumed MONTHLY consumption per native unit, used to turn a per-unit list
 *  price into a range. Numbers are the count of native units consumed per month
 *  (low → high). Exported so tests/callers compute expected ranges from the same
 *  source of truth. */
export interface VolumeBand {
  low: number;
  high: number;
}

export const ASSUMED_MONTHLY_VOLUME: Record<string, VolumeBand> = {
  // Request-priced: ~100k → 1M billable operations/month, expressed in 1k units.
  "per-1k-requests": { low: 100, high: 1000 },
  "per-1k-rru": { low: 100, high: 1000 },
  "per-1k-wru": { low: 100, high: 1000 },
  // Lambda compute: ~100k→1M invocations × 0.5 GB × 0.2 s ≈ 10k → 100k GB-seconds.
  "gb-second": { low: 10_000, high: 100_000 },
  // Storage: 10 → 100 GB-month.
  "gb-month": { low: 10, high: 100 },
  // Always-on capacity: 1 → 2 instances/nodes × 730 hr (single-AZ → multi-AZ).
  hour: { low: 730, high: 1460 },
  "lcu-hour": { low: 730, high: 1460 },
  "vcpu-hour": { low: 730, high: 1460 },
  // Fargate task memory: ~2 → 4 GB always-on.
  "gb-hour": { low: 1460, high: 2920 },
  // Identity: 1k → 50k monthly active users.
  "per-mau": { low: 1000, high: 50_000 },
  // Data transfer: 50 → 500 GB/month.
  "gb-internet-egress": { low: 50, high: 500 },
  "gb-transfer": { low: 50, high: 500 },
  "gb-cross-az": { low: 50, high: 500 },
  "gb-processed": { low: 50, high: 500 },
  // Flat monthly charges (WAF web ACL): fixed, band of 1.
  "web-acl-month": { low: 1, high: 1 },
};

/** Conservative fallback band for an unrecognized native unit. */
const DEFAULT_BAND: VolumeBand = { low: 1, high: 10 };

/** Services whose recurring cost is forced by the private-subnet default and
 *  must be surfaced explicitly when a tier egresses from a private subnet. */
const DATA_TRANSFER_DEFAULT_SERVICES = ["NAT Gateway", "Data Transfer"] as const;

/** Human-readable native-unit label for the `costDriver.unit` field (R6). */
const UNIT_LABEL: Record<string, string> = {
  "per-1k-requests": "per 1k requests",
  "per-1k-rru": "per 1k read units",
  "per-1k-wru": "per 1k write units",
  "gb-second": "$/GB-second",
  "gb-month": "$/GB-month",
  hour: "$/hr",
  "lcu-hour": "$/LCU-hr",
  "vcpu-hour": "$/vCPU-hr",
  "gb-hour": "$/GB-hr",
  "per-mau": "per MAU",
  "gb-internet-egress": "$/GB internet egress",
  "gb-transfer": "$/GB transferred",
  "gb-cross-az": "$/GB cross-AZ",
  "gb-processed": "$/GB processed",
  "web-acl-month": "$/web-ACL-month",
};

function unitLabel(unit: string): string {
  return UNIT_LABEL[unit] ?? unit;
}

/** Format a USD amount with enough precision to stay meaningful for sub-cent
 *  per-unit prices without noise on larger figures. */
export function formatUsd(n: number): string {
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  if (n > 0) return n.toFixed(4);
  return "0.00";
}

/** A monthly $ range string, e.g. "$16.43–$32.85/mo" (en-dash per schema). */
export function formatRange(lowUsd: number, highUsd: number): string {
  return `$${formatUsd(lowUsd)}–$${formatUsd(highUsd)}/mo`;
}

/** On-demand-list-price disclaimer attached to every estimate (R6/KTD6). */
export function onDemandDisclaimer(region: string): string {
  return (
    `Cost estimates are on-demand list prices for ${region}, presented as ranges ` +
    `over assumed monthly volumes. They exclude the AWS Free Tier, Savings Plans, ` +
    `Reserved Instances, and negotiated discounts.`
  );
}

/** Offline seed fallback, keyed by `service|region`, used only when the cache
 *  has no row for a service (then the estimate is flagged approximate). The seed
 *  is normally already loaded into the PricingStore at boot; this independent
 *  copy guards the case where a hand-seeded/partial store is missing a service. */
const SEED_FALLBACK: Map<string, PriceRecord[]> = buildSeedFallback();

function buildSeedFallback(): Map<string, PriceRecord[]> {
  const map = new Map<string, PriceRecord[]>();
  for (const f of pricingFacts as PricingFact[]) {
    const key = `${f.service}|${f.region}`;
    const record: PriceRecord = {
      service: f.service,
      region: f.region,
      unit: f.unit,
      usd: f.usd,
      month: "seed",
      note: f.note,
    };
    const bucket = map.get(key);
    if (bucket) bucket.push(record);
    else map.set(key, [record]);
  }
  return map;
}

/**
 * Normalize the model's free-form AWS service label to the canonical key used by
 * the pricing seed (strip "Amazon "/"AWS " marketing prefixes, map long names).
 */
function normalizeService(name: string): string {
  const stripped = name.trim().replace(/^(amazon|aws)\s+/i, "");
  const aliases: Record<string, string> = {
    "Application Load Balancer": "ALB",
    "Elastic Load Balancing": "ALB",
    "Elastic Load Balancer": "ALB",
    "Simple Queue Service": "SQS",
    "Simple Notification Service": "SNS",
    "Simple Storage Service": "S3",
    "Relational Database Service": "RDS",
    "Elastic Compute Cloud": "EC2",
    Lambda: "Lambda",
  };
  return aliases[stripped] ?? stripped;
}

interface PriceLookup {
  records: PriceRecord[];
  /** True when the cache had no row and we fell back to the offline seed. */
  approximate: boolean;
}

function lookupPrices(service: string, region: string, pricing: PricingStore): PriceLookup {
  const cached = pricing.get(service, region);
  if (cached.length > 0) return { records: cached, approximate: false };

  const seed =
    SEED_FALLBACK.get(`${service}|${region}`) ?? SEED_FALLBACK.get(`${service}|us-east-1`);
  if (seed && seed.length > 0) return { records: seed, approximate: true };

  return { records: [], approximate: true };
}

function driversForService(
  service: string,
  region: string,
  pricing: PricingStore,
  isPrivateSubnetDefault: boolean,
): CostDriver[] {
  const { records, approximate } = lookupPrices(service, region, pricing);
  return records.map((r) => {
    const band = ASSUMED_MONTHLY_VOLUME[r.unit] ?? DEFAULT_BAND;
    const estimateRange = formatRange(r.usd * band.low, r.usd * band.high);
    let note = r.note;
    if (isPrivateSubnetDefault) {
      note =
        `Required by the private-subnet security default (no public data tier) ` +
        `— the most common budget surprise. ${note}`;
    }
    if (approximate) {
      note = `Approximate (no cached price for ${service}; using offline seed fallback). ${note}`;
    }
    return { service: r.service, unit: unitLabel(r.unit), estimateRange, note };
  });
}

/**
 * Detect a tier that egresses from a private subnet, which forces a NAT gateway
 * + internet-egress recurring cost (R7 #5 / KTD6).
 *
 * LEANER SHAPE: the old per-tier `securityNotes`/`node.purpose` prose is gone, so
 * we read the new lean signals instead — node `security` TAGS + `role`, the tier
 * `delta`, and the global `securityFloor` (where the no-public-data-tier baseline
 * now lives, stated once). Signals: an affirmative private-subnet mention on a
 * node/delta, OR a private-by-default data tier (RDS / ElastiCache / EC2) when the
 * floor mandates a private data tier. We require BOTH the floor signal AND a
 * private data service for the service heuristic so a serverless tier (Lambda +
 * DynamoDB, no VPC, no NAT) does not falsely trip. We deliberately do NOT trip on
 * a bare "NAT" token — it appears in negative phrasing too ("no NAT required").
 */
function egressesFromPrivateSubnet(tier: Tier, securityFloor: readonly string[]): boolean {
  const tierSurface = [...tier.delta, ...tier.nodes.flatMap((n) => [n.role, ...n.security])]
    .join(" ")
    .toLowerCase();
  if (/private[ -]?subnet/.test(tierSurface)) return true;

  const floorForcesPrivateData = /private[ -]?subnet|no public data|public data/.test(
    securityFloor.join(" ").toLowerCase(),
  );
  if (!floorForcesPrivateData) return false;

  const services = new Set(tier.nodes.map((n) => normalizeService(n.awsService)));
  return services.has("RDS") || services.has("ElastiCache") || services.has("EC2");
}

function estimateTier(
  tier: Tier,
  pricing: PricingStore,
  region: string,
  securityFloor: readonly string[],
): Tier {
  const drivers: CostDriver[] = [];
  const seen = new Set<string>();
  const add = (d: CostDriver): void => {
    const key = `${d.service}|${d.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    drivers.push(d);
  };

  const services = uniqueOrdered(tier.nodes.map((n) => normalizeService(n.awsService)));
  for (const service of services) {
    for (const d of driversForService(service, region, pricing, false)) add(d);
  }

  // Surface the recurring NAT/egress cost the private-subnet default imposes,
  // even though no node "is" the NAT gateway — hiding it would make the secure
  // choice look free (KTD6).
  if (egressesFromPrivateSubnet(tier, securityFloor)) {
    for (const service of DATA_TRANSFER_DEFAULT_SERVICES) {
      for (const d of driversForService(service, region, pricing, true)) add(d);
    }
  }

  return { ...tier, costDrivers: drivers };
}

function uniqueOrdered(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Fill every tier's cost drivers deterministically from the cached PricingStore,
 * adding the private-subnet NAT/egress line where required and attaching the
 * on-demand-list-price disclaimer to the result's assumptions. Returns a new
 * result; the input is not mutated.
 */
export function estimateCosts(
  result: ArchitectureResult,
  pricing: PricingStore,
  region: string,
): ArchitectureResult {
  const tiers = result.tiers.map((tier) => estimateTier(tier, pricing, region, result.securityFloor));
  const disclaimer = onDemandDisclaimer(region);
  const assumptions = result.assumptions.includes(disclaimer)
    ? result.assumptions
    : [...result.assumptions, disclaimer];
  return { ...result, assumptions, tiers };
}
