/**
 * Cost estimate — the LEANER cost UI.
 *
 * The full driver table was heavy (a dozen+ rows on one tier). Instead we lead
 * with the estimated monthly band and the top few drivers, and tuck the full
 * table behind a "show all" disclosure. Native units + the on-demand disclaimer
 * still live in the full table (CostTable). Glossary tooltips surface on terms in
 * the driver notes.
 */

import type { CostDriver } from "../lib/types.js";
import { rollupCost, formatCostBand, parseMonthlyRange } from "../lib/cost.js";
import { driverKey, ladderForDriver, type SizeId } from "../lib/sizeLadder.js";
import { CostTable } from "./CostTable.js";
import { GlossaryText } from "./GlossaryText.js";
import { SizeSelector } from "./SizeSelector.js";

const TOP_N = 3;

/** Rank drivers by their monthly high (parseable monthly ranges first). */
function topDrivers(drivers: CostDriver[]): CostDriver[] {
  return [...drivers]
    .map((d) => ({ d, high: parseMonthlyRange(d.estimateRange)?.high ?? -1 }))
    .sort((a, b) => b.high - a.high)
    .slice(0, TOP_N)
    .map((x) => x.d);
}

export function CostEstimate({
  drivers,
  assumptions,
  sizeSelection,
  onSizeChange,
}: {
  drivers: CostDriver[];
  assumptions: string[];
  sizeSelection?: Record<string, SizeId>;
  onSizeChange?: (driverKey: string, size: SizeId) => void;
}): JSX.Element {
  const band = formatCostBand(rollupCost(drivers));
  const top = topDrivers(drivers);

  return (
    <section className="card cost" aria-label="Cost estimate">
      <div className="cost__head">
        <h3>Cost estimate</h3>
        {band && <span className="cost__band">{band}</span>}
      </div>

      {top.length > 0 && (
        <ul className="cost__top" aria-label="Top cost drivers">
          {top.map((d) => {
            const ladder = ladderForDriver(d);
            const key = driverKey(d);
            return (
              <li key={key} className="cost__top-row">
                <span className="cost__top-svc">{d.service}</span>
                {ladder && onSizeChange && sizeSelection && (
                  <SizeSelector
                    ladder={ladder}
                    selectedId={sizeSelection[key] ?? ladder.defaultId}
                    ariaLabel={d.service}
                    onSelect={(id) => onSizeChange(key, id)}
                  />
                )}
                <span className="cost__top-range">{d.estimateRange}</span>
                {d.note && (
                  <span className="cost__top-note">
                    {" — "}
                    <GlossaryText>{d.note}</GlossaryText>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {drivers.length > 0 && (
        <details className="cost__all">
          <summary>Show all {drivers.length} cost drivers</summary>
          <CostTable
            drivers={drivers}
            assumptions={assumptions}
            sizeSelection={sizeSelection}
            onSizeChange={onSizeChange}
          />
        </details>
      )}
    </section>
  );
}
