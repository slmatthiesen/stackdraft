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
import instancePricesSeed from "@drafture/kb/instance-prices.seed.json" with { type: "json" };
import type { PricingFact, InstancePriceTable } from "@drafture/kb";

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
 * TRAFFIC IS ITS OWN AXIS (reversed the old tier-as-scale-ladder). Volume is no
 * longer intrinsic to the tier: the customer states EXPECTED TRAFFIC once (intake
 * "expected monthly visitors"), that drives ONE volume scale, and the SAME scale is
 * applied to all three tiers. Tiers then differ ONLY by robustness
 * ({@link TIER_COST_MULTIPLIER}) — they are single-AZ → multi-AZ → multi-region
 * variants of ONE workload, not three different-sized apps. This removes a concept:
 * there is no per-tier volume stage anymore, so a budget box is never silently
 * priced for a traffic level the user never specified.
 *
 * The four bands are 10× steps; the default (<50k/mo, ≈ the old "balanced" centre)
 * keeps a fresh estimate where the showcased numbers used to sit.
 */
export const TRAFFIC_VOLUME_SCALE: Record<string, number> = {
  "<1k": 0.1,
  "<50k": 1,
  "<500k": 10,
  millions: 100,
};

/** Assumed band when the user skips the traffic question (skippable-intake UX). */
export const DEFAULT_TRAFFIC_BAND = "<50k";

/**
 * Parse the intake "expected monthly visitors" answer into a volume scale. The
 * customer states TRAFFIC only (never capacity); absent or unrecognized → the
 * sensible default band. Keyword-matched (most-specific first) so phrasing drift
 * ("< 500k", "500,000", "Millions a month") still resolves.
 */
export function trafficVolumeScale(answers: readonly string[] | undefined): number {
  const text = (answers ?? []).join(" \n ").toLowerCase();
  const fallback = TRAFFIC_VOLUME_SCALE[DEFAULT_TRAFFIC_BAND]!;
  if (!/expected monthly visitors/.test(text)) return fallback;
  if (/\bmillions?\b/.test(text)) return TRAFFIC_VOLUME_SCALE.millions!;
  if (/500\s*k|500,?000/.test(text)) return TRAFFIC_VOLUME_SCALE["<500k"]!;
  if (/50\s*k|50,?000/.test(text)) return TRAFFIC_VOLUME_SCALE["<50k"]!;
  if (/\b1\s*k\b|\b1,?000\b/.test(text)) return TRAFFIC_VOLUME_SCALE["<1k"]!;
  return fallback;
}

// --- Instance sizing (honor the architect's stated size, else a tier default) ----
//
// Capacity ($/hr) services that ARE a sized instance (EC2/RDS/Aurora/ElastiCache/
// OpenSearch) used to price at ONE fixed seed $/hr — e.g. EC2 = m5.large $70/mo —
// so a t4g.small the architect explicitly chose was billed as an m5.large. We now
// resolve the instance class: PARSE it from the node text when the architect stated
// one, else fall back to a per-tier default (budget→small … resilient→large, NEVER
// large-always), and price it from the shared {@link INSTANCE_PRICES} table. The
// driver is stamped with the resolved `instanceType` so the client size-ladder
// re-prices against the SAME absolute table (no ratio guessing → no double-apply).
const INSTANCE_PRICES: Record<string, number> = (instancePricesSeed as InstancePriceTable).prices;

interface InstanceFamily {
  /** Matches an explicit instance class the architect stated in the node text. */
  parse: RegExp;
  /** Fallback size when none stated — laddered by tier (robustness headroom). */
  defaults: Record<TierName, string>;
}

/** Canonical-service → instance family. Keyed to the names {@link normalizeService}
 *  produces. Fargate/ALB/NAT are NOT here (no instance class — they keep their seed
 *  $/hr). db.* prices are shared by RDS + Aurora. */
const INSTANCE_FAMILIES: Record<string, InstanceFamily> = {
  EC2: {
    parse: /(?<![\w.])(?!db\.|cache\.)[a-z]+\d[a-z]*\.(?:nano|micro|small|medium|large|\d*xlarge)\b(?!\.search)/i,
    defaults: { budget: "t4g.small", balanced: "t4g.large", resilient: "m7g.large" },
  },
  RDS: {
    parse: /\bdb\.[a-z]+\d[a-z]*\.(?:nano|micro|small|medium|large|\d*xlarge)\b/i,
    defaults: { budget: "db.t4g.small", balanced: "db.t4g.large", resilient: "db.r6g.large" },
  },
  Aurora: {
    parse: /\bdb\.[a-z]+\d[a-z]*\.(?:nano|micro|small|medium|large|\d*xlarge)\b/i,
    defaults: { budget: "db.t4g.medium", balanced: "db.r6g.large", resilient: "db.r6g.xlarge" },
  },
  ElastiCache: {
    parse: /\bcache\.[a-z]+\d[a-z]*\.(?:nano|micro|small|medium|large|\d*xlarge)\b/i,
    defaults: { budget: "cache.t4g.small", balanced: "cache.t4g.medium", resilient: "cache.r6g.large" },
  },
  OpenSearch: {
    parse: /\b[a-z]+\d[a-z]*\.(?:small|medium|large|\d*xlarge)\.search\b/i,
    defaults: { budget: "t3.small.search", balanced: "m6g.large.search", resilient: "r6g.large.search" },
  },
};

/** Resolve the instance class for an instance-backed $/hr service: the architect's
 *  stated class if it's in the price table, else the tier default. `undefined` for
 *  non-instance services (they keep their seed $/hr). */
function resolveInstanceType(service: string, nodeText: string, tierName: TierName): string | undefined {
  const family = INSTANCE_FAMILIES[service];
  if (!family) return undefined;
  const m = family.parse.exec(nodeText);
  if (m) {
    const stated = m[0].toLowerCase();
    if (INSTANCE_PRICES[stated] !== undefined) return stated;
  }
  return family.defaults[tierName];
}

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
 * encode), scaled by the traffic-driven volume scale ({@link trafficVolumeScale}).
 * The driver for payload-proportional traffic units so transfer/logs grow with
 * request count ONCE, instead of via a fixed band × the request multiplier (the old
 * double-count).
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
 *
 * Two stages: exact alias map, then a keyword fallback. The fallback catches the
 * descriptive labels the model emits that don't exact-match the seed — "ECS
 * Fargate task", "Aurora Serverless v2 (Postgres)", "SNS topic", "EventBridge
 * Scheduler" — which otherwise priced silently as $0 (GAP 3). Each pattern matches
 * a distinctive token at a word boundary; specific-first ordering.
 */
const KEYWORD_FALLBACK: ReadonlyArray<readonly [RegExp, string]> = [
  [/\baurora\b/i, "Aurora"],
  // "fargate" but NOT "fargate-compatible" / "fargate compatible" — the latter is a
  // task-definition PORTABILITY note on an EC2-backed ECS task, not a launch type, so
  // it must not price phantom Fargate (the real compute is the "ECS on EC2" node).
  [/\bfargate\b(?![- ]compatible)/i, "Fargate"],
  [/\beventbridge\b/i, "EventBridge"],
  [/\belasticache\b|\bredis\b|\bvalkey\b/i, "ElastiCache"],
  [/\bopensearch\b|\belasticsearch\b/i, "OpenSearch"],
  [/\bkinesis\b/i, "Kinesis"],
  [/\bdynamodb\b/i, "DynamoDB"],
  [/\bcognito\b/i, "Cognito"],
  [/\bcloudfront\b/i, "CloudFront"],
  [/\bsns\b/i, "SNS"],
  [/\bsqs\b/i, "SQS"],
  [/\bses\b/i, "SES"],
  [/\bwaf\b/i, "WAF"],
  [/\bx-?ray\b/i, "X-Ray"],
  [/\bebs\b/i, "EBS"],
];

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
  const aliased = aliases[stripped];
  if (aliased) return aliased;
  // ECS launch type drives the bill, not the word "ECS": an ECS-on-EC2 task is priced
  // as the EC2 instance, an ECS/Fargate task as Fargate. Resolve this explicitly so
  // "ECS on EC2" prices as EC2 (else it matched nothing → $0, hiding the real compute)
  // and a "Fargate-compatible" EC2 task doesn't fall through to the Fargate keyword.
  if (/\becs\b/i.test(stripped)) {
    if (/\bon ec2\b|\bec2\b|\bon-ec2\b/i.test(stripped)) return "EC2";
    if (/\bfargate\b(?![- ]compatible)/i.test(stripped)) return "Fargate";
  }
  for (const [pattern, canonical] of KEYWORD_FALLBACK) {
    if (pattern.test(stripped)) return canonical;
  }
  return stripped;
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
  instanceType?: string,
): CostDriver[] {
  const { records, approximate } = lookupPrices(service, region, pricing);
  return records.map((r) => {
    // The robustness premium (tierMultiplier) applies ONLY to capacity/always-on
    // units — the things redundancy actually duplicates (extra instances, replicas,
    // multi-AZ nodes). Request-priced, traffic, and storage units already scale
    // across tiers via volumeScale (0.1/1/10×) inside monthlyBand, so multiplying
    // them by tierMultiplier TOO double-counts scale (it made a resilient SES line
    // read $300–$3000/mo — 30× — when only the 10× volume step is real). Capacity
    // units don't scale by volume, so tierMultiplier is the only thing that moves
    // them across tiers; keep it there. Monotonicity holds either way (request lines
    // rise via volumeScale, capacity lines via tierMultiplier).
    // Instance-backed $/hr line: price the RESOLVED instance class from the shared
    // table instead of the single seed $/hr (the m5.large-always bug). The robustness
    // multiplier still layers on top (multi-AZ duplicates the box).
    const isInstanceHour =
      r.unit === "hour" && instanceType !== undefined && INSTANCE_PRICES[instanceType] !== undefined;
    const usd = isInstanceHour ? INSTANCE_PRICES[instanceType!]! : r.usd;
    const band = monthlyBand(r.unit, volumeScale);
    const effectiveMultiplier = CAPACITY_UNITS.has(r.unit) ? tierMultiplier : 1;
    const estimateRange = formatRange(
      usd * band.low * effectiveMultiplier,
      usd * band.high * effectiveMultiplier,
    );
    let note = isInstanceHour
      ? `Assumed-throughput estimate: ${instanceType} on-demand (us-east-1). Cost = instance count × running hours; storage/IO billed separately, multi-AZ via the tier multiplier.`
      : r.note;
    if (isPrivateSubnetDefault) {
      note =
        `Required by the private-subnet security default (no public data tier) ` +
        `— the most common budget surprise. ${note}`;
    }
    if (approximate) {
      note = `Approximate (no cached price for ${service}; using offline seed fallback). ${note}`;
    }
    const driver: CostDriver = { service: r.service, unit: unitLabel(r.unit), estimateRange, note };
    if (isInstanceHour) driver.instanceType = instanceType;
    return driver;
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
 * A node's tags explicitly say it lives in a PUBLIC subnet (or needs no NAT). This is
 * the documented single-public-instance budget shape: an EC2/ECS box with a public IP
 * behind a tight SG and DIRECT outbound egress — no NAT gateway. NAT exists only to
 * give PRIVATE-subnet resources egress, so a node that declares itself public must not
 * trip the NAT cost line. Matched on the node's security TAGS (where the model states
 * subnet placement), not free role prose.
 */
const PUBLIC_SUBNET_TAG = /\bpublic subnet\b|\bpublic ip\b|\bno (?:outbound )?nat\b|direct egress/i;

function isExplicitlyPublicSubnet(node: GeneratedTier["nodes"][number]): boolean {
  return node.security.some((tag) => PUBLIC_SUBNET_TAG.test(tag));
}

/**
 * Detect a tier that actually runs VPC-bound resources IN A PRIVATE SUBNET, which
 * forces a NAT gateway + internet-egress recurring cost (R7 #5 / KTD6).
 *
 * Trigger: a real VPC-bound service whose node is NOT explicitly public-subnet. We
 * deliberately do NOT trip on a bare "private subnet" text tag (the model sprinkles
 * it inconsistently, even onto pure-serverless tiers, which produced a phantom NAT
 * line). But we DO honor an explicit PUBLIC-subnet tag as an opt-out: the documented
 * budget shape is a single public-IP EC2/ECS box with direct egress and no NAT, so a
 * node tagged "public subnet"/"no NAT" must not fabricate a $33/mo gateway it doesn't
 * have. A pure-serverless tier (Lambda + DynamoDB + S3) matches no VPC service and
 * also correctly shows no NAT.
 */
function egressesFromPrivateSubnet(tier: GeneratedTier): boolean {
  return tier.nodes.some((n) => {
    const serviceSurface = `${n.awsService} ${n.role}`.toLowerCase();
    // Word-boundary match, not a bare substring: `includes("rds")` mis-fires on
    // "dashboaRDS" / "recoRDS" / "standaRDS", adding a PHANTOM NAT line to
    // pure-serverless tiers that merely have a dashboards/records node. `\bkw\b`
    // requires the VPC service to appear as its own token ("rds", "fargate"…),
    // which is what we actually mean.
    const isVpcBound = VPC_PRIVATE_SERVICE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(serviceSurface));
    return isVpcBound && !isExplicitlyPublicSubnet(n);
  });
}

function estimateTier(
  tier: GeneratedTier,
  pricing: PricingStore,
  region: string,
  volumeScale: number,
): Tier {
  const drivers: CostDriver[] = [];
  const seen = new Set<string>();
  const add = (d: CostDriver): void => {
    const key = `${d.service}|${d.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    drivers.push(d);
  };

  const tierMultiplier = TIER_COST_MULTIPLIER[tier.name];

  // Map each normalized service to the node text it came from (awsService + role),
  // first-seen order preserved, so an instance-backed service can read the architect's
  // stated instance class out of its own node prose.
  const serviceText = new Map<string, string>();
  for (const n of tier.nodes) {
    for (const raw of splitServices(n.awsService)) {
      const svc = normalizeService(raw);
      serviceText.set(svc, `${serviceText.get(svc) ?? ""} ${raw} ${n.role}`);
    }
  }

  for (const [service, text] of serviceText) {
    const instanceType = resolveInstanceType(service, text, tier.name);
    for (const d of driversForService(service, region, pricing, false, tierMultiplier, volumeScale, instanceType)) {
      add(d);
    }
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
  volumeScale: number = TRAFFIC_VOLUME_SCALE[DEFAULT_TRAFFIC_BAND]!,
): ArchitectureResult {
  const tiers = result.tiers.map((tier) => estimateTier(tier, pricing, region, volumeScale));
  // Disclaimer + the assumed traffic (now its own axis, shared across tiers) — stated
  // so a skipped traffic question still leaves the costing assumption visible. Both are
  // idempotent (re-running estimateCosts never duplicates them).
  const extras = [onDemandDisclaimer(region), trafficAssumption(volumeScale)].filter(
    (a) => !result.assumptions.includes(a),
  );
  const assumptions = extras.length > 0 ? [...result.assumptions, ...extras] : result.assumptions;
  return { ...result, assumptions, tiers };
}

/** Compact request count for assumption prose: 300000 → "300k", 1000000 → "1M". */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

/** The traffic the cost bands assume, stated for the user (skippable-intake UX). */
export function trafficAssumption(volumeScale: number): string {
  const low = compactCount(REQUESTS_PER_MONTH_BASE.low * volumeScale);
  const high = compactCount(REQUESTS_PER_MONTH_BASE.high * volumeScale);
  return (
    `Assumed traffic ~${low}–${high} requests/month, applied equally to all three tiers ` +
    `(tiers differ by robustness, not traffic). Set "expected monthly visitors" in intake to change it.`
  );
}
