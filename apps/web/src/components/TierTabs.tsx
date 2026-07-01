/**
 * U10 / R3 — budget / balanced / resilient tabs. Switching a tab re-renders the
 * selected tier's summary + diagram + what-changes delta + cost table + tradeoffs.
 *
 * KTD9: the budget tab/section is framed as the "minimum safe cost" — all three
 * tiers carry the full R7 security floor (shown once, globally), so budget is
 * never security-relaxed.
 */

import { useMemo, useState } from "react";
import { TIER_NAMES, type Tier, type TierName } from "../lib/types.js";
import { graphToMermaid } from "../lib/mermaid.js";
import { applySizeSelection } from "../lib/cost.js";
import { type SizeId } from "../lib/sizeLadder.js";
import { DiagramView } from "./DiagramView.js";
import { CostEstimate } from "./CostEstimate.js";
import { CostSummary } from "./CostSummary.js";
import { GlossaryText } from "./GlossaryText.js";

const TAB_LABELS: Record<TierName, string> = {
  budget: "Budget",
  balanced: "Balanced",
  resilient: "Resilient",
};

const TAB_SUBLABELS: Partial<Record<TierName, string>> = {
  budget: "minimum safe cost",
};

export function TierTabs({
  tiers,
  assumptions,
  selected,
  onSelect,
  onAddTier,
  addingTier,
}: {
  tiers: Tier[];
  assumptions: string[];
  /** Active tier — owned by the parent so the page-bottom Terraform tracks it. */
  selected: TierName;
  onSelect: (name: TierName) => void;
  /** Lazy per-tier (fix A): when provided, tiers NOT yet generated show a "+ Add"
   *  button that generates them on demand. Omitted (deep-linked/library designs) →
   *  only the tiers present render, exactly as before. */
  onAddTier?: (name: TierName) => void;
  /** The tier currently being generated (shows a spinner on its button). */
  addingTier?: TierName | null;
}): JSX.Element {
  const tier = tiers.find((t) => t.name === selected) ?? tiers[0];

  // With add-on-demand, always show all three tier slots (present → tab, absent →
  // "+ Add"); otherwise just the tiers we have, in their given order.
  const present = new Map(tiers.map((t) => [t.name, t] as const));
  const slots: TierName[] = onAddTier ? [...TIER_NAMES] : tiers.map((t) => t.name);

  // Per-tier instance-size overrides — only the user's EXPLICIT picks. There is no
  // auto-seeded default selection anymore: the server already priced each box at the
  // architect's size (or a tier default) and stamped its `instanceType`, so an empty
  // selection renders the server prices as-is. A pick re-prices off the absolute
  // instance table (see applySizeSelection) — no per-tier ratio, so no double-apply.
  const [sizeByTier, setSizeByTier] = useState<
    Partial<Record<TierName, Record<string, SizeId>>>
  >({});

  const sizeSelection = useMemo<Record<string, SizeId>>(
    () => (tier ? (sizeByTier[tier.name] ?? {}) : {}),
    [tier, sizeByTier],
  );

  const scaledDrivers = useMemo(
    () => (tier ? applySizeSelection(tier.costDrivers, sizeSelection) : []),
    [tier, sizeSelection],
  );

  const handleSizeChange = (key: string, id: SizeId): void => {
    if (!tier) return;
    setSizeByTier((prev) => ({
      ...prev,
      [tier.name]: { ...(prev[tier.name] ?? {}), [key]: id },
    }));
  };

  if (!tier) return <p>No tiers to display.</p>;

  return (
    <div className="tiers">
      <p className="tiers__hint">Compare tiers — tap one to switch the design below:</p>
      <div className="tiers__tablist" role="tablist" aria-label="Robustness tiers">
        {slots.map((name) => {
          const t = present.get(name);
          if (t) {
            return (
              <button
                key={name}
                role="tab"
                aria-selected={name === selected}
                className={`tiers__tab ${name === selected ? "tiers__tab--active" : ""}`}
                onClick={() => onSelect(name)}
              >
                <span className="tiers__tab-name">{TAB_LABELS[name]}</span>
                {TAB_SUBLABELS[name] && <span className="tiers__tab-sub">{TAB_SUBLABELS[name]}</span>}
              </button>
            );
          }
          // Absent tier → a "+ Add" affordance (fix A). Generates it on demand and
          // switches to it; the current tier stays visible until it lands.
          const busy = addingTier === name;
          return (
            <button
              key={name}
              type="button"
              className="tiers__tab tiers__tab--add"
              disabled={addingTier != null}
              aria-busy={busy}
              onClick={() => onAddTier?.(name)}
            >
              <span className="tiers__tab-name">{busy ? "Adding…" : `+ ${TAB_LABELS[name]}`}</span>
              <span className="tiers__tab-sub">{busy ? "generating" : "add tier"}</span>
            </button>
          );
        })}
      </div>

      <section className="tier" role="tabpanel" aria-label={`${TAB_LABELS[tier.name]} tier`}>
        <header className="tier__header">
          <h2>
            {TAB_LABELS[tier.name]}
            {tier.name === "budget" && (
              <span className="tier__tag"> — minimum safe cost</span>
            )}
          </h2>
          <p className="tier__summary">{tier.summary}</p>
          <CostSummary drivers={scaledDrivers} tierName={tier.name} />
          {tier.name === "budget" && (
            <p className="tier__safe-note">
              Lowest cost that still keeps the full security floor — never a security-relaxed option.
            </p>
          )}
        </header>

        {/* What-changes and trade-offs are two views of the same comparison, so
            they share one card to read as a single "how this tier differs" block. */}
        <section className="card tier-compare" aria-label="What changes and trade-offs vs other tiers">
          {tier.delta.length > 0 && (
            <>
              <h3>What changes in this tier</h3>
              <ul>
                {tier.delta.map((d, i) => (
                  <li key={i}>
                    <GlossaryText>{d}</GlossaryText>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className={tier.delta.length > 0 ? "tier-compare__second" : undefined}>
            Trade-offs vs other tiers
          </h3>
          <ul>
            {tier.tradeoffs.map((t, i) => (
              <li key={i}>
                <GlossaryText>{t}</GlossaryText>
              </li>
            ))}
          </ul>
        </section>

        {/* Diagram sits between the prose and the cost breakdown: read what the
            tier is and what changes, see it, then price it. Top-to-bottom flow
            keeps it from sprawling wide off the right of the screen. */}
        <DiagramView chart={graphToMermaid(tier.nodes, tier.edges, "TB")} />

        <CostEstimate
          drivers={tier.costDrivers}
          assumptions={assumptions}
          sizeSelection={sizeSelection}
          onSizeChange={handleSizeChange}
        />
      </section>
    </div>
  );
}
