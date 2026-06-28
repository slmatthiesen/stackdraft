/**
 * Deterministic, CLIENT-SIDE cost rollup (no backend call).
 *
 * Sums the low/high ends of each cost driver's monthly `estimateRange` into a
 * rough per-tier monthly band. Only ranges expressed as a monthly total
 * ("$LOW–$HIGH/mo") are summed; per-unit prices (e.g. "$0.023/GB-mo") and
 * anything unparseable are skipped, and `partial` flags that the band omits some
 * drivers. This is an order-of-magnitude estimate, never a quote.
 */

import type { CostDriver, TierName } from "./types.js";
import {
  ladderForDriver,
  driverKey,
  optionFor,
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
 * Assumed request volume each tier is costed at — MIRRORS the API's
 * `TIER_VOLUME_SCALE` (apps/api/src/pipeline/cost.ts), anchored at 10k/day for
 * balanced (×0.1 / ×1 / ×10). The cost bands are computed from the same scale
 * server-side, so these MUST move together — otherwise the "assumes ~X/day" label
 * misstates the volume behind the dollars.
 */
export const TIER_REQUESTS_PER_DAY: Record<TierName, number> = {
  budget: 1_000,
  balanced: 10_000,
  resilient: 100_000,
};

const DAYS_PER_MONTH = 30;

/** The tier's assumed request volume, per day and per (30-day) month. */
export function assumedTraffic(tier: TierName): { perDay: number; perMonth: number } {
  const perDay = TIER_REQUESTS_PER_DAY[tier];
  return { perDay, perMonth: perDay * DAYS_PER_MONTH };
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
 * Roughly the cost added per extra 10K requests/month AT THIS TIER — the slope of
 * the variable (traffic-driven) cost. Sums the spread (high − low) of the VARIABLE
 * drivers only (fixed always-on/storage drivers don't grow with requests), then
 * divides by the tier's monthly request-band width (= 90 × requests/day, i.e. the
 * 100k–1M base band scaled by this tier) and rescales to 10K. 0 when there's no
 * traffic-driven cost (a tier whose whole bill is always-on capacity).
 */
export function marginalPer10kRequests(drivers: CostDriver[], tier: TierName): number {
  let variableSpread = 0;
  for (const d of drivers) {
    if (isFixedUnit(d.unit)) continue;
    const parsed = parseMonthlyRange(d.estimateRange);
    if (parsed) variableSpread += parsed.high - parsed.low;
  }
  const monthlyBandWidth = 90 * TIER_REQUESTS_PER_DAY[tier];
  if (monthlyBandWidth <= 0) return 0;
  return (variableSpread * 10_000) / monthlyBandWidth;
}

// --- Instance-size selection (GAP 1) -----------------------------------------
// Re-scale a capacity driver's monthly range by the selected size's price RATIO,
// so a user right-sizing EC2/RDS/… sees every downstream number update live. Pure
// and non-mutating; returns the original driver object unchanged at medium
// (ratio 1) so the showcased default band stays byte-identical to the seed output.

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
 * drivers pass through unchanged; adjustable ones have their parsed low/high
 * multiplied by the selected size's ratio and re-stringified. Medium (ratio 1)
 * is a no-op that returns the original driver, preserving the seed's exact range.
 */
export function applySizeSelection(
  drivers: CostDriver[],
  selection: Record<string, SizeId>,
): CostDriver[] {
  return drivers.map((d) => {
    const ladder = ladderForDriver(d);
    if (!ladder) return d;
    const parsed = parseMonthlyRange(d.estimateRange);
    if (!parsed) return d;
    const ratio = optionFor(ladder, selection[driverKey(d)]).ratio;
    if (ratio === 1) return d;
    return {
      ...d,
      estimateRange: formatRange(parsed.low * ratio, parsed.high * ratio),
    };
  });
}
