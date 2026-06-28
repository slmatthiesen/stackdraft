/**
 * Monthly AWS pricing refresh job (U7 / R6 / R10 / KTD6).
 *
 * Walks the PUBLIC AWS Price List Bulk offer-index JSON — no AWS credentials:
 *   service index  (/offers/v1.0/aws/index.json)
 *     → per-service region index   (offers[code].currentRegionIndexUrl)
 *       → per-region price file     (regions[region].currentVersionUrl)
 * extracts `terms.OnDemand.*.priceDimensions.*.pricePerUnit.USD` joined to
 * `products.*.attributes` by SKU, normalizes into each service's NATIVE unit
 * (per-1k where that unit exists; Lambda dual-unit; storage/$hr/$GB kept native),
 * and atomically swaps the month's rows in `PricingStore` via `replaceMonth`.
 *
 * Failure posture (R10): on ANY error — or if nothing extracts — we DO NOT touch
 * the cache (no partial wipe). The previously-cached month (or the seed loaded at
 * boot) stands as the offline fallback. The job returns a structured result and
 * never throws out of `refreshPricing`.
 *
 * ── Huge-file seam ───────────────────────────────────────────────────────────
 * Per-region price files are HUNDREDS OF MEGABYTES (S3/EC2). The parse step is
 * abstracted behind `RefreshDeps.loadRegionFile` so:
 *   • production injects a STREAMING loader (SAX/stream-json) that emits only
 *     `products.*` + `terms.OnDemand.*` and never holds the whole file resident;
 *   • tests inject a tiny in-memory fixture object — no network, no large alloc.
 * All normalization downstream consumes the same `RegionPriceFile` shape, so the
 * streaming swap is local to that one seam. The default loader (below) buffers
 * and is documented as production-unsafe for the large services.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { getConfig } from "../src/config.js";
import { createStores, getDb } from "../src/store/sqlite.js";
import type { PriceRecord, PricingStore } from "../src/store/types.js";

const BASE_URL = "https://pricing.us-east-1.amazonaws.com";
const INDEX_URL = `${BASE_URL}/offers/v1.0/aws/index.json`;

// ── Bulk offer-index shapes (only the fields we read) ────────────────────────

interface OfferIndexEntry {
  offerCode?: string;
  currentRegionIndexUrl?: string;
  currentVersionUrl?: string;
}
interface OfferIndexFile {
  offers: Record<string, OfferIndexEntry>;
}
interface RegionIndexEntry {
  regionCode?: string;
  currentVersionUrl?: string;
}
interface RegionIndexFile {
  regions: Record<string, RegionIndexEntry>;
}

interface OfferProduct {
  sku?: string;
  productFamily?: string;
  attributes?: Record<string, string>;
}
interface PriceDimension {
  unit?: string;
  pricePerUnit?: { USD?: string };
}
interface OfferTerm {
  priceDimensions?: Record<string, PriceDimension>;
}

/**
 * A parsed AWS Bulk region price file. The LOADER decides how this is produced
 * (streaming in production, fixture in tests); everything below operates on this
 * shape so it is never coupled to the I/O strategy.
 */
export interface RegionPriceFile {
  products: Record<string, OfferProduct>;
  terms: { OnDemand: Record<string, Record<string, OfferTerm>> };
}

/** A single SKU×price-dimension row, product attributes joined in. */
interface RawOffer {
  sku: string;
  productFamily: string;
  attributes: Record<string, string>;
  usd: number;
  /** The AWS-reported unit token, e.g. "Requests", "GB-Seconds", "GB-Mo", "Hrs". */
  awsUnit: string;
}

/** Normalization rule for one tracked service. */
interface ServiceSpec {
  /** Canonical name written to PriceRecord.service (matches the pricing seed). */
  service: string;
  /** AWS Bulk offer code, e.g. "AWSLambda". */
  offerCode: string;
  /** Map a raw offer to a native-unit price, or null to ignore it. */
  select(offer: RawOffer): { unit: string; usd: number; note: string } | null;
}

// ── Per-service native-unit normalization (KTD6) ─────────────────────────────
// Native units are NOT forced to per-1,000: request-priced services get per-1k
// (= AWS per-unit price × 1000); capacity/time-priced services keep $/hr with an
// explicit assumed-throughput note; storage stays $/GB-mo; transfer stays $/GB.

const PER_1K = 1000;

function requestSpec(service: string, offerCode: string): ServiceSpec {
  return {
    service,
    offerCode,
    select(o) {
      if (o.awsUnit !== "Requests") return null;
      // per-1k = per-request list price × 1000 (equivalently per-million ÷ 1000).
      return {
        unit: "per-1k-requests",
        usd: o.usd * PER_1K,
        note: `${service} on-demand requests; per-1k normalized from the AWS per-request list price.`,
      };
    },
  };
}

function hourlySpec(service: string, offerCode: string, note: string): ServiceSpec {
  return {
    service,
    offerCode,
    select(o) {
      if (o.awsUnit !== "Hrs" && o.awsUnit !== "Hours") return null;
      // Time-priced: no native per-1k unit — flagged assumed-throughput (KTD6).
      return { unit: "hour", usd: o.usd, note };
    },
  };
}

const SERVICE_SPECS: ServiceSpec[] = [
  {
    service: "Lambda",
    offerCode: "AWSLambda",
    select(o) {
      const group = (o.attributes.group ?? "").toLowerCase();
      if (o.awsUnit === "Requests" || group.includes("request")) {
        return {
          unit: "per-1k-requests",
          usd: o.usd * PER_1K,
          note: "Lambda requests; per-1k normalized from the AWS per-request list price.",
        };
      }
      if (o.awsUnit === "GB-Seconds" || group.includes("duration")) {
        // Dual-unit service: also priced on compute GB-seconds (KTD6).
        return {
          unit: "gb-second",
          usd: o.usd,
          note: "Lambda compute duration ($/GB-second). Multiply by memoryGB × durationSeconds.",
        };
      }
      return null;
    },
  },
  requestSpec("API Gateway", "AmazonApiGateway"),
  requestSpec("SQS", "AWSQueueService"),
  requestSpec("SNS", "AmazonSNS"),
  {
    service: "DynamoDB",
    offerCode: "AmazonDynamoDB",
    select(o) {
      // On-demand read/write request units → per-1k (1 RRU ≤4KB read, 1 WRU ≤1KB write).
      if (/read/i.test(o.awsUnit) || /readrequest/i.test(o.attributes.group ?? "")) {
        return { unit: "per-1k-rru", usd: o.usd * PER_1K, note: "On-demand read request units; per-1k normalized." };
      }
      if (/write/i.test(o.awsUnit) || /writerequest/i.test(o.attributes.group ?? "")) {
        return { unit: "per-1k-wru", usd: o.usd * PER_1K, note: "On-demand write request units; per-1k normalized." };
      }
      return null;
    },
  },
  {
    service: "S3",
    offerCode: "AmazonS3",
    select(o) {
      if (o.awsUnit === "Requests") {
        return { unit: "per-1k-requests", usd: o.usd * PER_1K, note: "S3 request tier; per-1k normalized." };
      }
      if (o.awsUnit === "GB-Mo" || o.awsUnit === "GB-Month") {
        return { unit: "gb-month", usd: o.usd, note: "S3 storage ($/GB-month)." };
      }
      return null;
    },
  },
  {
    service: "CloudFront",
    offerCode: "AmazonCloudFront",
    select(o) {
      if (o.awsUnit === "Requests") {
        return { unit: "per-1k-requests", usd: o.usd * PER_1K, note: "CloudFront HTTPS requests; per-1k normalized." };
      }
      if (o.awsUnit === "GB") {
        return { unit: "gb-transfer", usd: o.usd, note: "CloudFront data transfer out ($/GB)." };
      }
      return null;
    },
  },
  // Data transfer is a first-class unit (KTD6). Lives under the EC2 offer.
  {
    service: "Data Transfer",
    offerCode: "AmazonEC2",
    select(o) {
      if (o.productFamily !== "Data Transfer" || o.awsUnit !== "GB") return null;
      const kind = `${o.attributes.transferType ?? ""} ${o.attributes.usagetype ?? ""}`;
      if (/out/i.test(kind) || /internet/i.test(kind)) {
        return {
          unit: "gb-internet-egress",
          usd: o.usd,
          note: "Data transfer out to internet ($/GB) — assumed-throughput; the most common budget surprise.",
        };
      }
      return null;
    },
  },
  // NAT gateway — forced by the private-subnet security default (KTD6/R7 #5).
  {
    service: "NAT Gateway",
    offerCode: "AmazonVPC",
    select(o) {
      if (!/nat/i.test(o.productFamily) && !/nat/i.test(o.attributes.group ?? "")) return null;
      if (o.awsUnit === "GB") {
        return { unit: "gb-processed", usd: o.usd, note: "NAT gateway data processed ($/GB)." };
      }
      if (o.awsUnit === "Hrs" || o.awsUnit === "Hours") {
        return { unit: "hour", usd: o.usd, note: "NAT gateway hourly charge (always-on per AZ)." };
      }
      return null;
    },
  },
  hourlySpec("EC2", "AmazonEC2", "EC2 on-demand instance ($/hr) — assumed-throughput; depends on instance count × hours."),
  hourlySpec("RDS", "AmazonRDS", "RDS instance ($/hr) — assumed-throughput; multi-AZ ~2×; storage billed separately."),
  hourlySpec("ElastiCache", "AmazonElastiCache", "ElastiCache node ($/hr) — assumed-throughput; cost = node count × hours."),
  hourlySpec("ALB", "AWSELB", "Application Load Balancer hourly charge ($/hr, always-on)."),
  {
    service: "Cognito",
    offerCode: "AmazonCognito",
    select(o) {
      if (/mau/i.test(o.awsUnit) || /active user/i.test(o.attributes.group ?? "")) {
        return { unit: "per-mau", usd: o.usd, note: "Cognito per monthly active user — assumed-throughput." };
      }
      return null;
    },
  },
];

// ── Pure extraction + normalization (fixture-testable, no I/O) ────────────────

/** Join `terms.OnDemand` price dimensions to `products` attributes by SKU. */
export function extractRawOffers(file: RegionPriceFile): RawOffer[] {
  const out: RawOffer[] = [];
  const onDemand = file.terms?.OnDemand ?? {};
  for (const [sku, termMap] of Object.entries(onDemand)) {
    const product = file.products?.[sku];
    if (!product) continue;
    for (const term of Object.values(termMap)) {
      const dims = term.priceDimensions ?? {};
      for (const dim of Object.values(dims)) {
        const usdStr = dim.pricePerUnit?.USD;
        if (usdStr == null) continue;
        const usd = Number(usdStr);
        if (!Number.isFinite(usd)) continue;
        out.push({
          sku,
          productFamily: product.productFamily ?? "",
          attributes: product.attributes ?? {},
          usd,
          awsUnit: dim.unit ?? "",
        });
      }
    }
  }
  return out;
}

/** Normalize one service's region file into native-unit PriceRecords. When
 *  several offers map to the same native unit (tiers), keep the cheapest — the
 *  first-tier list price — so the result is deterministic. */
export function normalizeRegionFile(
  spec: ServiceSpec,
  file: RegionPriceFile,
  region: string,
  month: string,
): PriceRecord[] {
  const byUnit = new Map<string, PriceRecord>();
  for (const offer of extractRawOffers(file)) {
    const mapped = spec.select(offer);
    if (!mapped) continue;
    const existing = byUnit.get(mapped.unit);
    if (!existing || mapped.usd < existing.usd) {
      byUnit.set(mapped.unit, {
        service: spec.service,
        region,
        unit: mapped.unit,
        usd: mapped.usd,
        month,
        note: mapped.note,
      });
    }
  }
  return [...byUnit.values()];
}

// ── Injectable I/O seam ──────────────────────────────────────────────────────

export interface RefreshDeps {
  /** Fetch a small JSON index file (service index / region index). */
  fetchJson(url: string): Promise<unknown>;
  /** Load + parse a per-region price file. PRODUCTION MUST STREAM (see header). */
  loadRegionFile(url: string): Promise<RegionPriceFile>;
  /** Injectable clock so the snapshot month is testable. */
  now(): Date;
}

function absUrl(pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/**
 * Default region-file loader.
 *
 * PRODUCTION CAVEAT: per-region Bulk files are HUNDREDS OF MB (S3/EC2). This
 * buffers the whole body and JSON.parses it — memory-heavy, acceptable only for
 * the smaller service files in a generously-sized one-off refresh container. For
 * the large services INJECT a streaming `loadRegionFile` backed by a SAX /
 * stream-json parser that emits only `products.*` + `terms.OnDemand.*`. The seam
 * is `RefreshDeps.loadRegionFile`, so the swap never touches normalization.
 * Tests never reach this path — they inject a fixture loader.
 */
async function defaultLoadRegionFile(url: string): Promise<RegionPriceFile> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as RegionPriceFile;
}

const defaultDeps: RefreshDeps = {
  fetchJson: defaultFetchJson,
  loadRegionFile: defaultLoadRegionFile,
  now: () => new Date(),
};

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

export interface RefreshResult {
  ok: boolean;
  region: string;
  month: string;
  servicesRefreshed: number;
  recordsWritten: number;
  /** True when the cache was left intact and the seed/prior month stands. */
  fellBackToSeed: boolean;
  error?: string;
}

export interface RefreshOptions {
  pricing: PricingStore;
  region: string;
  deps?: Partial<RefreshDeps>;
}

/**
 * Run the monthly refresh. Never throws: on failure it returns a structured
 * result with `fellBackToSeed:true` and leaves the cache untouched (R10).
 */
export async function refreshPricing(opts: RefreshOptions): Promise<RefreshResult> {
  const deps: RefreshDeps = { ...defaultDeps, ...opts.deps };
  const { pricing, region } = opts;
  const month = monthKey(deps.now());
  const base: Omit<RefreshResult, "ok" | "fellBackToSeed"> = {
    region,
    month,
    servicesRefreshed: 0,
    recordsWritten: 0,
  };

  try {
    const index = (await deps.fetchJson(INDEX_URL)) as OfferIndexFile;
    const records: PriceRecord[] = [];
    let servicesRefreshed = 0;

    for (const spec of SERVICE_SPECS) {
      const offer = index.offers?.[spec.offerCode];
      if (!offer?.currentRegionIndexUrl) continue;

      const regionIndex = (await deps.fetchJson(
        absUrl(offer.currentRegionIndexUrl),
      )) as RegionIndexFile;
      const regionEntry = regionIndex.regions?.[region];
      if (!regionEntry?.currentVersionUrl) continue;

      const file = await deps.loadRegionFile(absUrl(regionEntry.currentVersionUrl));
      const recs = normalizeRegionFile(spec, file, region, month);
      if (recs.length > 0) {
        records.push(...recs);
        servicesRefreshed++;
      }
    }

    // Extracting nothing means the schema shifted or the walk broke — treat as a
    // failure and leave the cache intact rather than wiping it to empty (R10).
    if (records.length === 0) {
      return {
        ...base,
        ok: false,
        fellBackToSeed: true,
        error: "no records extracted (offer schema may have changed)",
      };
    }

    // Atomic swap of this month's rows; prior months/seed are untouched.
    pricing.replaceMonth(region, month, records);
    return {
      ...base,
      ok: true,
      servicesRefreshed,
      recordsWritten: records.length,
      fellBackToSeed: false,
    };
  } catch (err) {
    // Any failure: do NOT call replaceMonth — the existing cache/seed stands.
    return {
      ...base,
      ok: false,
      fellBackToSeed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── CLI entrypoint (pnpm --filter @drafture/api refresh-pricing) ───────────

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb(config.DB_PATH);
  try {
    const { pricing } = createStores(db);
    const result = await refreshPricing({ pricing, region: config.DEFAULT_REGION });
    // Structured one-line log; a failed refresh is non-fatal (seed stands).
    console.log(JSON.stringify({ event: "pricing_refresh", ...result }));
    if (!result.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
}

// Only auto-run when invoked directly; importing in tests must not execute it.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
