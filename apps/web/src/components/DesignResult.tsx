/**
 * The tiered design view — extracted verbatim from App's `phase === "result"` block
 * so the same renderer serves a fresh generation AND a deep-linked `/design/:id`.
 *
 * Diagram leads (TierTabs at the top), then the optional "useful design?" feedback,
 * the key decisions, the global security floor, assumptions, and finally the
 * tier-specific reference Terraform.
 *
 * `feedback` is optional on purpose: the thumbs-up/down keys off a fresh generation's
 * prompt inputs, which re-opened (deep-linked / history / curated) designs don't carry
 * — so they render the design without it, exactly as the inline view always has.
 */
import { KeyDecisions } from "./KeyDecisions.js";
import { ReferenceConfig } from "./ReferenceConfig.js";
import { SecurityPanel } from "./SecurityPanel.js";
import { TierTabs } from "./TierTabs.js";
import type { GenerateResponse, TierName } from "../lib/types.js";

export interface DesignFeedback {
  rating: 1 | -1 | null;
  busy: boolean;
  onRate: (rating: 1 | -1) => void;
}

export function DesignResult({
  result,
  selectedTier,
  onSelectTier,
  onAddTier,
  addingTier,
  feedback,
  generationId,
}: {
  result: GenerateResponse;
  selectedTier: TierName;
  onSelectTier: (tier: TierName) => void;
  /** Lazy per-tier (fix A): add balanced/resilient on demand from the tier tabs. Only
   *  wired for a fresh result (Home); deep-linked designs render present tiers as-is. */
  onAddTier?: (tier: TierName) => void;
  addingTier?: TierName | null;
  feedback?: DesignFeedback;
  /** Stored-design id threaded into the Terraform pull so a re-pull is free. */
  generationId?: string;
}): JSX.Element {
  return (
    <>
      {/* Diagram leads: the tier tabs (Budget/Balanced/Resilient — Budget generated
          first, the others added on demand) sit at the top so the design is visible
          immediately. */}
      <TierTabs
        tiers={result.tiers}
        assumptions={result.assumptions}
        selected={selectedTier}
        onSelect={onSelectTier}
        onAddTier={onAddTier}
        addingTier={addingTier}
      />

      {/* Useful-design rating sits just above the key decisions — after the
          reader has seen the diagram, before the reasoning. */}
      {feedback && (
        <section className="banner banner--recommend">
          <div
            className="recommend__feedback"
            role="group"
            aria-label="Rate this design"
          >
            <span className="recommend__feedback-label">
              {feedback.rating !== null ? "Thanks — feedback saved!" : "Useful design?"}
            </span>
            <button
              type="button"
              className={`recommend__thumb recommend__thumb--up${feedback.rating === 1 ? " recommend__thumb--on" : ""}`}
              aria-label="Good design"
              aria-pressed={feedback.rating === 1}
              disabled={feedback.busy || feedback.rating !== null}
              onClick={() => feedback.onRate(1)}
            >
              👍
            </button>
            <button
              type="button"
              className={`recommend__thumb recommend__thumb--down${feedback.rating === -1 ? " recommend__thumb--on" : ""}`}
              aria-label="Needs improvement"
              aria-pressed={feedback.rating === -1}
              disabled={feedback.busy || feedback.rating !== null}
              onClick={() => feedback.onRate(-1)}
            >
              👎
            </button>
          </div>
        </section>
      )}

      <KeyDecisions decisions={result.keyDecisions} />

      <SecurityPanel floor={result.securityFloor} />

      {result.assumptions.length > 0 && (
        <section className="card assumptions" aria-label="Assumptions">
          <h2>Assumptions</h2>
          <ul>
            {result.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Terraform last: read the design, security floor, and assumptions
          first, then grab the tier-specific reference file. */}
      <ReferenceConfig
        tier={
          result.tiers.find((t) => t.name === selectedTier) ?? result.tiers[0]!
        }
        generationId={generationId}
      />
    </>
  );
}
