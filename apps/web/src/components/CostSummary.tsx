/**
 * Per-tier rough monthly cost band + the zero-traffic baseline — deterministic,
 * client-side (no backend). Sums the monthly cost-driver ranges; see `lib/cost.ts`.
 *
 * The range is the at-volume band (low → high request volume). The baseline is the
 * FIXED floor (always-on capacity + storage) you'd pay at ZERO traffic — surfaced
 * so a wide range like ~$0–$774/mo reads as "free at rest, traffic-driven" rather
 * than mysteriously variable. See `baselineCost` in lib/cost.ts.
 */
import type { CostDriver, TierName } from "../lib/types.js";
import {
  rollupCost,
  formatCostBand,
  baselineCost,
  formatMoney,
  assumedTraffic,
  formatRequests,
  marginalPer10kRequests,
} from "../lib/cost.js";

export function CostSummary({
  drivers,
  tierName,
}: {
  drivers: CostDriver[];
  /** When given, shows the tier's assumed traffic + a per-10K-requests marginal tip. */
  tierName?: TierName;
}): JSX.Element | null {
  const rollup = rollupCost(drivers);
  const band = formatCostBand(rollup);
  if (!band) return null;
  const baseline = baselineCost(drivers);
  const hasBaseline = baseline >= 0.5; // a real always-on floor vs. scales-to-zero

  const traffic = tierName ? assumedTraffic(tierName) : null;
  const marginal = tierName ? marginalPer10kRequests(drivers, tierName) : 0;
  const marginalTip =
    marginal >= 0.005
      ? `Scales with traffic: about +$${formatMoney(marginal)} per additional 10K requests/mo at this tier.`
      : undefined;

  return (
    <div className="cost-summary">
      <p className="cost-summary__head">
        <span
          className={`cost-summary__band${marginalTip ? " tip-host" : ""}`}
          data-tip={marginalTip}
          tabIndex={marginalTip ? 0 : undefined}
        >
          {band}
        </span>{" "}
        <span className="cost-summary__label">
          estimated{rollup.partial ? " · partial — some drivers not summed" : ""}
        </span>
      </p>
      {traffic && (
        <p className="cost-summary__traffic">
          Assumes ~{formatRequests(traffic.perDay)} requests/day (~{formatRequests(traffic.perMonth)}/month).
        </p>
      )}
      <p className="cost-summary__baseline">
        {hasBaseline ? (
          <>
            <strong>${formatMoney(baseline)}/mo baseline</strong> at zero traffic (always-on +
            storage); the range above scales with request volume + data transfer.
          </>
        ) : (
          <>
            <strong>~$0/mo at zero traffic</strong> — no always-on services; the range is entirely
            request volume + data transfer.
          </>
        )}
      </p>
    </div>
  );
}
