/**
 * Cost estimate — the LEANER cost UI.
 *
 * The full driver table was heavy (a dozen+ rows on one tier). Instead we lead
 * with the estimated monthly band and the top few drivers, and tuck the full
 * table behind a "show all" disclosure. Native units + the on-demand disclaimer
 * still live in the full table (CostTable). Glossary tooltips surface on terms in
 * the driver notes.
 */

import { useMemo } from "react";
import type { CostDriver } from "../lib/types.js";
import { applySizeSelection, rollupCost, formatCostBand, parseMonthlyRange } from "../lib/cost.js";
import { driverKey, ladderForDriver, defaultSizeForDriver, type SizeId } from "../lib/sizeLadder.js";
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
  // Scale drivers for DISPLAY, but rank the top-3 from the BASE drivers so
  // resizing a service never reorders the list — the row you're clicking stays
  // put; only its range updates.
  const scaled = useMemo(
    () => applySizeSelection(drivers, sizeSelection ?? {}),
    [drivers, sizeSelection],
  );
  const scaledByKey = new Map(scaled.map((d) => [driverKey(d), d]));
  const band = formatCostBand(rollupCost(scaled));
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
            const view = scaledByKey.get(key) ?? d;
            return (
              <li key={key} className="cost__top-row">
                <span className="cost__top-svc">{d.service}</span>
                {ladder && onSizeChange && sizeSelection && (
                  <SizeSelector
                    ladder={ladder}
                    selectedId={sizeSelection[key] ?? defaultSizeForDriver(d, ladder)}
                    ariaLabel={d.service}
                    onSelect={(id) => onSizeChange(key, id)}
                  />
                )}
                <span className="cost__top-range">{view.estimateRange}</span>
                {view.note && (
                  <span className="cost__top-note">
                    {" — "}
                    <GlossaryText>{view.note}</GlossaryText>
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
            drivers={scaled}
            assumptions={assumptions}
            sizeSelection={sizeSelection}
            onSizeChange={onSizeChange}
          />
        </details>
      )}
    </section>
  );
}
