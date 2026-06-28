/**
 * Instance-size ladder — a MANUAL override for per-tier cost customization
 * (instance sizing, GAP 1).
 *
 * The server already prices each capacity ($/hr) instance at the class the architect
 * chose (or a tier default) and STAMPS the driver with that `instanceType`. This
 * ladder lets a user swap to a neighboring class and watch the price move — purely
 * client-side, using the SAME absolute `instance-prices.seed.json` table the server
 * priced from. No ratios: the re-price is `price[picked] / price[server's class]`, so
 * the default selection (the server's class) is always a no-op (ratio 1). That kills
 * the old double-apply trap, where the client multiplied by a per-tier ratio (0.22)
 * ON TOP of a server price that already reflected the size.
 *
 * Prices are grounded estimates (us-east-1 on-demand), consistent with the
 * "order-of-magnitude, never a quote" cost model.
 */
import instancePrices from "@drafture/kb/instance-prices.seed.json";
import type { InstancePriceTable } from "@drafture/kb";
import type { CostDriver } from "./types.js";

export type SizeId = "s" | "m" | "l";

/** instanceType → us-east-1 on-demand $/hr (shared with the API cost engine). */
export const INSTANCE_PRICES: Record<string, number> = (instancePrices as InstancePriceTable).prices;

export function priceOf(instanceType: string | undefined): number | undefined {
  return instanceType === undefined ? undefined : INSTANCE_PRICES[instanceType];
}

export interface SizeOption {
  id: SizeId;
  /** Single-glyph label for the segmented control (S / M / L). */
  label: string;
  /** Real instance class — the authoritative label AND the absolute-price key. */
  instanceType: string;
}

export interface SizeLadder {
  /** Neutral fallback when the driver carries no server-stamped class. */
  defaultId: SizeId;
  sizes: SizeOption[];
}

// S/M/L mirror the server's per-tier DEFAULTS for each family (budget→S, balanced→M,
// resilient→L). Picking one re-prices off its absolute instance price — no ratios.
export const SIZE_LADDER: Record<string, SizeLadder> = {
  EC2: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "t4g.small" },
      { id: "m", label: "M", instanceType: "t4g.large" },
      { id: "l", label: "L", instanceType: "m7g.large" },
    ],
  },
  RDS: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "db.t4g.small" },
      { id: "m", label: "M", instanceType: "db.t4g.large" },
      { id: "l", label: "L", instanceType: "db.r6g.large" },
    ],
  },
  ElastiCache: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "cache.t4g.small" },
      { id: "m", label: "M", instanceType: "cache.t4g.medium" },
      { id: "l", label: "L", instanceType: "cache.r6g.large" },
    ],
  },
  Aurora: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "db.t4g.medium" },
      { id: "m", label: "M", instanceType: "db.r6g.large" },
      { id: "l", label: "L", instanceType: "db.r6g.xlarge" },
    ],
  },
  OpenSearch: {
    defaultId: "m",
    sizes: [
      { id: "s", label: "S", instanceType: "t3.small.search" },
      { id: "m", label: "M", instanceType: "m6g.large.search" },
      { id: "l", label: "L", instanceType: "r6g.large.search" },
    ],
  },
};

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

/**
 * The size to PRE-SELECT for a driver: the ladder option whose class matches the
 * server-stamped `instanceType`, else the ladder default. This makes the default
 * selection the size the server already priced, so the displayed range is unchanged
 * until the user actively picks a different one (no auto-ratio seeding).
 */
export function defaultSizeForDriver(d: CostDriver, ladder: SizeLadder): SizeId {
  const match = ladder.sizes.find((s) => s.instanceType === d.instanceType);
  return match?.id ?? ladder.defaultId;
}

/** The absolute-price baseline a manual re-size scales FROM: the server's stamped
 *  class if priced, else the pre-selected option's class. */
export function baseInstanceType(d: CostDriver, ladder: SizeLadder): string {
  if (d.instanceType !== undefined && INSTANCE_PRICES[d.instanceType] !== undefined) return d.instanceType;
  return optionFor(ladder, defaultSizeForDriver(d, ladder)).instanceType;
}
