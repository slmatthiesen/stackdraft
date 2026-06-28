/**
 * Deterministic, CLIENT-SIDE cost rollup (no backend call).
 *
 * Sums the low/high ends of each cost driver's monthly `estimateRange` into a
 * rough per-tier monthly band. Only ranges expressed as a monthly total
 * ("$LOW–$HIGH/mo") are summed; per-unit prices (e.g. "$0.023/GB-mo") and
 * anything unparseable are skipped, and `partial` flags that the band omits some
 * drivers. This is an order-of-magnitude estimate, never a quote.
 */

import type { CostDriver } from "./types.js";
import {
  ladderForDriver,
  driverKey,
  optionFor,
  baseInstanceType,
  INSTANCE_PRICES,
  type SizeId,
} from "./sizeLadder.js";

export interface CostRollup {
  low: number;
  high: number;
  /** Number of drivers that contributed to the band. */
  counted: number;
  /** True when one or more drivers were skipped (unparseable / per-unit). */
  partial: boolean;
}

// "$12–$30/mo", "$0.20 - $0.90 /mo", "$1,200 to $2,000/month". Endpoints are two
// dollar amounts joined by a dash/"to"; a /mo(nth) suffix marks it as a monthly total.
const MONTHLY_RANGE =
  /\$\s*([\d,]+(?:\.\d+)?)\s*(?:[–—-]|to)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\/\s*mo(?:nth)?/i;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/** Parse a single driver's monthly range, or null when it isn't a monthly band. */
export function parseMonthlyRange(estimateRange: string): { low: number; high: number } | null {
  const m = MONTHLY_RANGE.exec(estimateRange);
  if (!m) return null;
  const low = toNumber(m[1]!);
  const high = toNumber(m[2]!);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

export function rollupCost(drivers: CostDriver[]): CostRollup {
  let low = 0;
  let high = 0;
  let counted = 0;
  for (const d of drivers) {
    const parsed = parseMonthlyRange(d.estimateRange);
    if (!parsed) continue;
    low += parsed.low;
    high += parsed.high;
    counted += 1;
  }
  return { low, high, counted, partial: counted < drivers.length };
}

/**
 * A driver whose cost is FIXED — always-on capacity (per-hour: NAT/ALB/ElastiCache/
 * EC2/Fargate) or storage / flat monthly charges (per-month). These recur even at
 * ZERO traffic, so they form the baseline. Per-request / per-GB units are variable
 * (traffic-driven) and excluded. Recognized by a per-hour or per-month unit label.
 */
function isFixedUnit(unit: string): boolean {
  return /hr|hour|month/i.test(unit);
}

/**
 * The monthly cost of just RUNNING these services with zero traffic — the
 * always-on + storage floor, i.e. the fixed-unit drivers at their low end. $0 for
 * a pure-serverless tier (Lambda + DynamoDB + S3-on-demand scale to zero at rest),
 * which is exactly why a serverless range can span $0 → hundreds: the spread is
 * traffic, not fixed cost.
 */
export function baselineCost(drivers: CostDriver[]): number {
  let baseline = 0;
  for (const d of drivers) {
    if (!isFixedUnit(d.unit)) continue;
    const parsed = parseMonthlyRange(d.estimateRange);
    if (parsed) baseline += parsed.low;
  }
  return baseline;
}

export function formatMoney(n: number): string {
  if (n >= 10) return String(Math.round(n));
  // Keep cents for small numbers, trimming trailing zeros (1.50 → "1.5", 2.00 → "2").
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** "~$15–$48/mo" for a rollup, or null when nothing parsed. */
export function formatCostBand(rollup: CostRollup): string | null {
  if (rollup.counted === 0) return null;
  return `~$${formatMoney(rollup.low)}–$${formatMoney(rollup.high)}/mo`;
}

/**
 * Default assumed request volume the displayed bands sit at — the <50k-visitor
 * intake default (~10k requests/day ≈ 300k/month), matching the API's default
 * volume scale. Traffic is its OWN axis now (reversed the per-tier scale ladder):
 * the same volume across all three tiers, so this is a single constant, not a
 * per-tier map. The precise level a live generation used is also stated in the
 * result assumptions.
 */
export const ASSUMED_REQUESTS_PER_DAY = 10_000;

const DAYS_PER_MONTH = 30;

/** The assumed request volume, per day and per (30-day) month — same for all tiers. */
export function assumedTraffic(): { perDay: number; perMonth: number } {
  return { perDay: ASSUMED_REQUESTS_PER_DAY, perMonth: ASSUMED_REQUESTS_PER_DAY * DAYS_PER_MONTH };
}

/** Compact request count: 1_000 → "1K", 300_000 → "300K", 3_000_000 → "3M". */
export function formatRequests(n: number): string {
  if (n >= 1_000_000) return `${trimZeros(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimZeros(n / 1_000)}K`;
  return String(n);
}

function trimZeros(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/**
 * Roughly the cost added per extra 10K requests/month — the slope of the variable
 * (traffic-driven) cost. Sums the spread (high − low) of the VARIABLE drivers only
 * (fixed always-on/storage drivers don't grow with requests), then divides by the
 * assumed monthly request-band width (= 90 × requests/day, the 100k–1M base band)
 * and rescales to 10K. 0 when there's no traffic-driven cost (a bill that's all
 * always-on capacity).
 */
export function marginalPer10kRequests(drivers: CostDriver[]): number {
  let variableSpread = 0;
  for (const d of drivers) {
    if (isFixedUnit(d.unit)) continue;
    const parsed = parseMonthlyRange(d.estimateRange);
    if (parsed) variableSpread += parsed.high - parsed.low;
  }
  const monthlyBandWidth = 90 * ASSUMED_REQUESTS_PER_DAY;
  if (monthlyBandWidth <= 0) return 0;
  return (variableSpread * 10_000) / monthlyBandWidth;
}

// --- Instance-size selection (GAP 1) -----------------------------------------
// Re-price a capacity driver by the ABSOLUTE prices of the selected vs. the
// server-priced instance class (price[picked] / price[server's class]) — NOT a
// per-tier ratio. So a user right-sizing EC2/RDS/… sees every downstream number
// update live, and the default (the server's class) is a no-op (ratio 1). Pure and
// non-mutating. This is the two-sided half of the GAP-1 fix: the server prices the
// architect's size, the client re-prices off the SAME table, so the two never
// double-apply (the old bug: server price × a client 0.22 ratio).

/** Format a USD endpoint like the API does (2–4 decimals by magnitude). */
export function formatUsd(n: number): string {
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  if (n > 0) return n.toFixed(4);
  return "0.00";
}

/** A monthly $ range string, e.g. "$15.42–$30.84/mo". The en-dash + /mo shape is
 *  load-bearing: parseMonthlyRange returns null without it, silently dropping the
 *  driver from the rollup. Mirrors the API's formatRange byte-for-byte. */
export function formatRange(lowUsd: number, highUsd: number): string {
  return `$${formatUsd(lowUsd)}–$${formatUsd(highUsd)}/mo`;
}

/**
 * Apply per-service size selections to a tier's cost drivers. Non-adjustable
 * drivers, and adjustable ones with NO explicit selection, pass through unchanged —
 * the server's price stands (no auto-seeded ratio). An explicit selection re-prices
 * the parsed low/high by `price[picked] / price[server's class]`; picking the size
 * the server already used is a no-op (ratio 1), preserving the exact server range.
 */
export function applySizeSelection(
  drivers: CostDriver[],
  selection: Record<string, SizeId>,
): CostDriver[] {
  return drivers.map((d) => {
    const ladder = ladderForDriver(d);
    if (!ladder) return d;
    const sel = selection[driverKey(d)];
    if (sel === undefined) return d; // no explicit override → keep the server price
    const parsed = parseMonthlyRange(d.estimateRange);
    if (!parsed) return d;
    const basePrice = INSTANCE_PRICES[baseInstanceType(d, ladder)];
    const pickedPrice = INSTANCE_PRICES[optionFor(ladder, sel).instanceType];
    if (!basePrice || !pickedPrice) return d;
    const ratio = pickedPrice / basePrice;
    if (ratio === 1) return d;
    return {
      ...d,
      estimateRange: formatRange(parsed.low * ratio, parsed.high * ratio),
    };
  });
}
