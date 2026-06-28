/**
 * U10 / R3 — budget / balanced / resilient tabs. Switching a tab re-renders the
 * selected tier's summary + diagram + what-changes delta + cost table + tradeoffs.
 *
 * KTD9: the budget tab/section is framed as the "minimum safe cost" — all three
 * tiers carry the full R7 security floor (shown once, globally), so budget is
 * never security-relaxed.
 */

import type { Tier, TierName } from "../lib/types.js";
import { graphToMermaid } from "../lib/mermaid.js";
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
}: {
  tiers: Tier[];
  assumptions: string[];
  /** Active tier — owned by the parent so the page-bottom Terraform tracks it. */
  selected: TierName;
  onSelect: (name: TierName) => void;
}): JSX.Element {
  const tier = tiers.find((t) => t.name === selected) ?? tiers[0];

  if (!tier) return <p>No tiers to display.</p>;

  return (
    <div className="tiers">
      <p className="tiers__hint">Compare tiers — tap one to switch the design below:</p>
      <div className="tiers__tablist" role="tablist" aria-label="Robustness tiers">
        {tiers.map((t) => (
          <button
            key={t.name}
            role="tab"
            aria-selected={t.name === selected}
            className={`tiers__tab ${t.name === selected ? "tiers__tab--active" : ""}`}
            onClick={() => onSelect(t.name)}
          >
            <span className="tiers__tab-name">{TAB_LABELS[t.name]}</span>
            {TAB_SUBLABELS[t.name] && (
              <span className="tiers__tab-sub">{TAB_SUBLABELS[t.name]}</span>
            )}
          </button>
        ))}
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
          <CostSummary drivers={tier.costDrivers} tierName={tier.name} />
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

        <CostEstimate drivers={tier.costDrivers} assumptions={assumptions} />
      </section>
    </div>
  );
}
