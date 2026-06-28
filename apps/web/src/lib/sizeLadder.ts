/**
 * Instance-size ladder for per-tier cost customization (the "instance-size
 * selection" path from the cost-honesty roadmap, GAP 1).
 *
 * Capacity services ($/hr, always-on) each carry ONE default price in the seed
 * (EC2 = m5.large, RDS = db.t3.medium, …). This ladder lets the UI scale a
 * driver's monthly range by a size RATIO (medium = 1) so a user can right-size a
 * box and watch the price move live — pure client-side, no API call.
 *
 * Ratios are grounded in real us-east-1 on-demand prices (monthly ≈ usd × 730 hr)
 * but are ESTIMATES — consistent with the existing "order-of-magnitude, never a
 * quote" cost model. The medium entry's ratio (1) + instanceType mirror the seed,
 * so the default band is unchanged until a user picks a different size.
 *
 * The seeded default varies by tier (Budget→small, Balanced→medium, Resilient→
 * large), so a fresh Budget estimate already shows a cheap box — one mechanism
 * delivers both the cost-cleanup goal (GAP 1) and the user-config goal.
 */
import type { CostDriver, TierName } from "./types.js";

export type SizeId = "s" | "m" | "l";

export interface SizeOption {
  id: SizeId;
  /** Single-glyph label for the segmented control (S / M / L). */
  label: string;
  /** Real-ish instance type — shown as the authoritative label next to the control. */
  instanceType: string;
  /** Price relative to the seed's default (medium = 1). */
  ratio: number;
}

export interface SizeLadder {
  /** Neutral fallback when no per-tier default applies. */
  defaultId: SizeId;
  sizes: SizeOption[];
}

// medium (ratio 1) mirrors the seed default for each service; small/large are the
// neighboring real instance classes at their on-demand price ratio.
export const SIZE_LADDER: Record<string, SizeLadder> = {
  EC2: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "t3.small", ratio: 0.22 },
      { id: "m", label: "M", instanceType: "m5.large", ratio: 1 },
      { id: "l", label: "L", instanceType: "m5.xlarge", ratio: 2 },
    ],
  },
  RDS: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "db.t3.micro", ratio: 0.25 },
      { id: "m", label: "M", instanceType: "db.t3.medium", ratio: 1 },
      { id: "l", label: "L", instanceType: "db.m5.large", ratio: 2 },
    ],
  },
  ElastiCache: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "cache.t3.micro", ratio: 0.25 },
      { id: "m", label: "M", instanceType: "cache.t3.medium", ratio: 1 },
      { id: "l", label: "L", instanceType: "cache.m5.large", ratio: 2 },
    ],
  },
  Aurora: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "db.t3.small", ratio: 0.5 },
      { id: "m", label: "M", instanceType: "db.t3.medium", ratio: 1 },
      { id: "l", label: "L", instanceType: "db.r5.large", ratio: 2 },
    ],
  },
  OpenSearch: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "t3.micro.search", ratio: 0.5 },
      { id: "m", label: "M", instanceType: "t3.small.search", ratio: 1 },
      { id: "l", label: "L", instanceType: "m5.large.search", ratio: 2 },
    ],
  },
};

/** Per-tier seeded size — Budget starts on the cheap box, Resilient on the big one. */
const TIER_DEFAULT_SIZE: Record<TierName, SizeId> = {
  budget: "s",
  balanced: "m",
  resilient: "l",
};

export function defaultSizeFor(tier: TierName): SizeId {
  return TIER_DEFAULT_SIZE[tier];
}

/** The capacity unit label the seed renders for $/hr services (see lib/cost.ts UNIT_LABEL). */
const CAPACITY_UNIT_LABEL = "$/hr";

/** A driver's ladder if it's an adjustable capacity service, else null. */
export function ladderForDriver(d: CostDriver): SizeLadder | null {
  if (d.unit !== CAPACITY_UNIT_LABEL) return null;
  return SIZE_LADDER[d.service] ?? null;
}

/** Stable identity matching the API's cost-driver dedup key (service|unit). */
export function driverKey(d: CostDriver): string {
  return `${d.service}|${d.unit}`;
}

/** Resolve a size option, falling back to the ladder's default. */
export function optionFor(ladder: SizeLadder, id: SizeId | undefined): SizeOption {
  const resolved = id ?? ladder.defaultId;
  return ladder.sizes.find((s) => s.id === resolved) ?? ladder.sizes[1]!;
}
