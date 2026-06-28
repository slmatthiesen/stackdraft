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
import pricingFacts from "@drafture/kb/pricing-facts.seed.json" with { type: "json" };
import type { PricingFact } from "@drafture/kb";

import type {
  ArchitectureBeforeCost,
  ArchitectureResult,
  CostDriver,
  GeneratedTier,
  Tier,
  TierName,
} from "../schema/architecture.js";
import type { PriceRecord, PricingStore } from "../store/types.js";

/**
 * Per-tier ROBUSTNESS multiplier (KTD6). The three tiers differ along the
 * robustness axis — single-AZ → multi-AZ → multi-AZ + replicas / provisioned
 * concurrency / cross-region / backups — and that robustness costs real money, so
 * a resilient tier must NOT show the same totals as budget. We model it
 * deterministically by scaling each tier's whole estimate: the base volume band
 * captures within-tier volume uncertainty, and this factor captures the
 * redundancy premium each higher tier layers on the SAME workload (more always-on
 * capacity, provisioned concurrency, replicas/backups, retries, cross-AZ/region
 * duplication). Applied to ALL units so the tiers are always monotonic
 * (budget < balanced < resilient) even for a pure-serverless design where there
 * are no always-on capacity lines to scale.
 */
export const TIER_COST_MULTIPLIER: Record<TierName, number> = {
  budget: 1,
  balanced: 2,
  resilient: 3,
};

/**
 * Per-tier VOLUME stage — the scale each tier is costed AT, orthogonal to the
 * robustness premium above. The three tiers are a growth ladder, not three
 * robustness variants of one fixed load: each is a 10× step in request volume,
 * centered (band geometric mean) on roughly 1k / 10k / 100k requests PER DAY for
 * budget / balanced / resilient. This deliberately targets the 80/20 of real
 * workloads — most apps live in the 1k–100k/day range — rather than a millions/day
 * outlier. The user picks a tier and is shown that scale's bill, deterministically,
 * with no intake volume knob in the loop. Applied to the assumed monthly-volume
 * bands, then the robustness multiplier layers on top (resilient ≈ 10× volume ×
 * 3× robustness).
 */
export const TIER_VOLUME_SCALE: Record<TierName, number> = {
  budget: 0.1, // ~1k requests/day
  balanced: 1, // ~10k requests/day (the showcased default)
  resilient: 10, // ~100k requests/day
};

/** Assumed MONTHLY consumption per native unit for REQUEST / CAPACITY / STORAGE
 *  units — the count of native units consumed per month (low → high). Exported so
 *  tests/callers compute expected ranges from the same source of truth.
 *
 *  NOT listed here: payload-proportional TRAFFIC units (data transfer, log
 *  ingestion, NAT-processed, cross-AZ). Those are derived from request volume × a
 *  small per-request payload in {@link TRAFFIC_BYTES_PER_REQUEST} / {@link
 *  monthlyBand}, NOT a fixed GB band. A fixed band × the "millions = ×30" request
 *  multiplier double-counted scale and made a redirect-only service (a URL
 *  shortener) look like it spent $15k/mo on logs. */
export interface VolumeBand {
  low: number;
  high: number;
}

export const ASSUMED_MONTHLY_VOLUME: Record<string, VolumeBand> = {
  // Request-priced: ~100k → 1M billable operations/month, expressed in 1k units.
  "per-1k-requests": { low: 100, high: 1000 },
  "per-1k-rru": { low: 100, high: 1000 },
  "per-1k-wru": { low: 100, high: 1000 },
  // WebSocket connection-minutes: ~1M–10M/month (concurrent connections × uptime).
  "per-1m-conn-min": { low: 1, high: 10 },
  // Lambda compute: ~100k→1M invocations × 0.5 GB × 0.2 s ≈ 10k → 100k GB-seconds.
  "gb-second": { low: 10_000, high: 100_000 },
  // Storage at rest: 10 → 100 GB-month (NOT request-proportional).
  "gb-month": { low: 10, high: 100 },
  // Always-on capacity: 1 → 2 instances/nodes × 730 hr (single-AZ → multi-AZ).
  hour: { low: 730, high: 1460 },
  "lcu-hour": { low: 730, high: 1460 },
  "vcpu-hour": { low: 730, high: 1460 },
  // Fargate task memory: ~2 → 4 GB always-on.
  "gb-hour": { low: 1460, high: 2920 },
  // Identity: 1k → 50k monthly active users.
  "per-mau": { low: 1000, high: 50_000 },
  // Flat monthly charges (WAF web ACL): fixed, band of 1.
  "web-acl-month": { low: 1, high: 1 },
};

/** Conservative fallback band for an unrecognized native unit. */
const DEFAULT_BAND: VolumeBand = { low: 1, high: 10 };

/**
 * Baseline monthly REQUEST volume (the same 100k–1M/mo the request-priced bands
 * encode), scaled by the tier's volume stage ({@link TIER_VOLUME_SCALE}). The driver for payload-
 * proportional traffic units so transfer/logs grow with request count ONCE,
 * instead of via a fixed band × the request multiplier (the old double-count).
 */
export const REQUESTS_PER_MONTH_BASE: VolumeBand = { low: 100_000, high: 1_000_000 };

/**
 * Payload-proportional traffic units as ASSUMED BYTES PER REQUEST (GB = monthly
 * requests × bytes-per-request). A redirect / JSON response is a few KB out; a
 * structured log line is a couple hundred bytes. These are honest, workload-
 * agnostic middle estimates (a media site transfers more per request, a URL
 * shortener ~400 B less) — what matters is they scale with request volume, the
 * real driver, instead of a blunt fixed GB band that blew up high-volume /
 * tiny-payload services.
 */
export const TRAFFIC_BYTES_PER_REQUEST: Record<string, number> = {
  "gb-internet-egress": 5_000, // outbound response payload (~5 KB)
  "gb-transfer": 5_000,
  "gb-cross-az": 5_000, // inter-AZ hop ≈ the response payload
  "gb-processed": 5_000, // NAT-processed outbound ≈ the response payload
  "gb-ingested": 200, // one structured CloudWatch log line (~200 B)
};

/**
 * Monthly consumption band for a native unit. Request/capacity/storage units use
 * their fixed band × the traffic multiplier (unchanged). Payload-proportional
 * traffic units derive GB from request volume × bytes-per-request — the traffic
 * multiplier is already baked into the request count, so it is NOT re-applied
 * (that re-scaling was the cost bug). The tier multiplier is applied by the caller.
 */
/**
 * Always-on CAPACITY units — priced per hour of UPTIME, not per request. A NAT
 * gateway, ALB, or always-on Fargate task costs the same whether the tier serves
 * 1k or 100k requests/day, so the request-volume ladder (TIER_VOLUME_SCALE) MUST
 * NOT scale them: doing so made budget show a $3/mo NAT gateway (really ~$33) and
 * resilient a $2,956 one (really ~$100). They move only with topology — captured
 * by the per-tier robustness multiplier the caller applies on top of this band.
 */
const CAPACITY_UNITS: ReadonlySet<string> = new Set([
  "hour",
  "lcu-hour",
  "vcpu-hour",
  "gb-hour",
  "web-acl-month",
]);

function monthlyBand(unit: string, volumeScale: number): VolumeBand {
  const bytes = TRAFFIC_BYTES_PER_REQUEST[unit];
  if (bytes !== undefined) {
    const gb = (req: number): number => (req * volumeScale * bytes) / 1e9;
    return { low: gb(REQUESTS_PER_MONTH_BASE.low), high: gb(REQUESTS_PER_MONTH_BASE.high) };
  }
  const base = ASSUMED_MONTHLY_VOLUME[unit] ?? DEFAULT_BAND;
  // Capacity is traffic-independent — return the fixed uptime band unscaled; the
  // caller's tier multiplier carries the topology (single-AZ → multi-AZ → multi-region).
  if (CAPACITY_UNITS.has(unit)) return base;
  return { low: base.low * volumeScale, high: base.high * volumeScale };
}

/** Services whose recurring cost is forced by the private-subnet default and
 *  must be surfaced explicitly when a tier egresses from a private subnet. */
const DATA_TRANSFER_DEFAULT_SERVICES = ["NAT Gateway", "Data Transfer"] as const;

/** Human-readable native-unit label for the `costDriver.unit` field (R6). */
const UNIT_LABEL: Record<string, string> = {
  "per-1k-requests": "per 1k requests",
  "per-1k-rru": "per 1k read units",
  "per-1k-wru": "per 1k write units",
  "per-1m-conn-min": "$/M connection-min",
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
  "gb-ingested": "$/GB ingested",
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
    "API Gateway WebSocket APIs": "API Gateway WebSocket",
    "API Gateway WebSocket API": "API Gateway WebSocket",
    "API Gateway WebSocket": "API Gateway WebSocket",
    "WebSocket API": "API Gateway WebSocket",
    Lambda: "Lambda",
  };
  return aliases[stripped] ?? stripped;
}

/**
 * The model often groups services in one node label ("CloudFront + WAF",
 * "API Gateway / Lambda", "SNS and SQS"); split on the separators so EACH service
 * is priced instead of the whole combined label missing a price match (and the
 * tier silently dropping those cost lines). AWS service names contain no such
 * separators, so this never over-splits.
 */
function splitServices(awsService: string): string[] {
  return awsService
    .split(/\s*[+/]\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  tierMultiplier: number,
  volumeScale: number,
): CostDriver[] {
  const { records, approximate } = lookupPrices(service, region, pricing);
  return records.map((r) => {
    // Traffic units carry the volume multiplier inside monthlyBand (request-driven);
    // request/capacity units take it via the fixed band × volumeScale. Either way the
    // tier's robustness premium (tierMultiplier) is applied on top here.
    const band = monthlyBand(r.unit, volumeScale);
    const estimateRange = formatRange(
      r.usd * band.low * tierMultiplier,
      r.usd * band.high * tierMultiplier,
    );
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
 * VPC-bound services: any of these implies the tier runs resources in a private
 * subnet (the no-public-data-tier baseline), which forces the recurring NAT
 * gateway + internet-egress cost. Matched as substrings against the node's AWS
 * service + role, so marketing prefixes and exact spelling don't matter. This is
 * the BROAD, deterministic discriminator that replaces the old narrow {RDS,
 * ElastiCache, EC2} set — the bug was that a tier using Aurora / Fargate / ECS /
 * OpenSearch (all VPC-bound, all private-subnet) did NOT trip, so the NAT/egress
 * line appeared inconsistently across tiers. A pure-serverless tier (Lambda +
 * DynamoDB + S3, no VPC) matches none of these and correctly shows no NAT.
 */
export const VPC_PRIVATE_SERVICE_KEYWORDS = [
  "rds",
  "aurora",
  "elasticache",
  "opensearch",
  "elasticsearch",
  "redshift",
  "ec2",
  "fargate",
  "ecs",
  "eks",
  "msk",
  "kafka",
  "neptune",
  "documentdb",
  "memorydb",
  "emr",
] as const;

/**
 * Detect a tier that actually runs VPC-bound resources, which forces a NAT gateway
 * + internet-egress recurring cost (R7 #5 / KTD6).
 *
 * The ONLY trigger is the presence of a real VPC-bound service. We deliberately do
 * NOT trip on a "private subnet" text tag: the model sprinkles that phrase
 * inconsistently — even onto pure-serverless tiers (Lambda + DynamoDB + S3, no
 * VPC) — which produced a PHANTOM NAT line on some tiers and not others, making a
 * serverless budget tier look like it cost $40+/mo for a gateway it doesn't have.
 * Anchoring on the service list makes NAT correct (only when there's VPC compute/
 * data) and consistent across every tier that has it.
 */
function egressesFromPrivateSubnet(tier: GeneratedTier): boolean {
  return tier.nodes.some((n) => {
    const serviceSurface = `${n.awsService} ${n.role}`.toLowerCase();
    // Word-boundary match, not a bare substring: `includes("rds")` mis-fires on
    // "dashboaRDS" / "recoRDS" / "standaRDS", adding a PHANTOM NAT line to
    // pure-serverless tiers that merely have a dashboards/records node. `\bkw\b`
    // requires the VPC service to appear as its own token ("rds", "fargate"…),
    // which is what we actually mean.
    return VPC_PRIVATE_SERVICE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(serviceSurface));
  });
}

function estimateTier(tier: GeneratedTier, pricing: PricingStore, region: string): Tier {
  const drivers: CostDriver[] = [];
  const seen = new Set<string>();
  const add = (d: CostDriver): void => {
    const key = `${d.service}|${d.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    drivers.push(d);
  };

  const tierMultiplier = TIER_COST_MULTIPLIER[tier.name];
  // The scale this tier is costed at — budget launch-scale → resilient millions.
  const volumeScale = TIER_VOLUME_SCALE[tier.name];

  const services = uniqueOrdered(tier.nodes.flatMap((n) => splitServices(n.awsService).map(normalizeService)));
  for (const service of services) {
    for (const d of driversForService(service, region, pricing, false, tierMultiplier, volumeScale)) add(d);
  }

  // Surface the recurring NAT/egress cost a VPC-bound tier imposes, even though no
  // node "is" the NAT gateway — hiding it would make the secure choice look free
  // (KTD6).
  if (egressesFromPrivateSubnet(tier)) {
    for (const service of DATA_TRANSFER_DEFAULT_SERVICES) {
      for (const d of driversForService(service, region, pricing, true, tierMultiplier, volumeScale)) add(d);
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
  result: ArchitectureBeforeCost,
  pricing: PricingStore,
  region: string,
): ArchitectureResult {
  const tiers = result.tiers.map((tier) => estimateTier(tier, pricing, region));
  const disclaimer = onDemandDisclaimer(region);
  const assumptions = result.assumptions.includes(disclaimer)
    ? result.assumptions
    : [...result.assumptions, disclaimer];
  return { ...result, assumptions, tiers };
}
