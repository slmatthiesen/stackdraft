/**
 * The "drafting your architecture…" loading state.
 *
 * When driven by a STREAMING generation (fix D) it shows REAL progress: the current
 * pipeline phase and a live output heartbeat ("drafting… ~N tokens") off the provider's
 * stream, so the decode-bound wait reads as genuine motion instead of a timer. Without
 * stream props it falls back to the old rotating-phase animation (used by any caller
 * that isn't streaming). role="status" keeps it announced to assistive tech.
 */
import { useEffect, useState } from "react";
import type { StreamItem } from "../lib/api.js";

const PHASES = [
  "Reviewing your requirements",
  "Choosing the right AWS services",
  "Wiring the data flow",
  "Sizing and costing each tier",
  "Applying the security floor",
  "Weighing the trade-offs",
];

const PHASE_MS = 2200;

/** Map a server phase step to a human label (fix D streaming). */
const STEP_LABEL: Record<string, string> = {
  preparing: "Reviewing your requirements",
  generating: "Designing the architecture",
  costing: "Sizing and costing the tier",
  saving: "Finalizing your design",
};

/** Per-kind glyph for the live build list. */
const ITEM_GLYPH: Record<StreamItem["kind"], string> = { decision: "◆", node: "◇", edge: "→" };
const ITEM_VERB: Record<StreamItem["kind"], string> = { decision: "decided", node: "placed", edge: "wired" };

export function LoadingDraft({
  phase,
  chars,
  items,
}: {
  phase?: string;
  chars?: number;
  /** Design elements streamed so far (fix D) — rendered as a live "building" list. */
  items?: StreamItem[];
} = {}): JSX.Element {
  const streaming = phase !== undefined;
  const [rotated, setRotated] = useState(0);

  // Timed rotation ONLY in the non-streaming fallback; a live stream drives the label.
  useEffect(() => {
    if (streaming) return;
    const t = setInterval(() => setRotated((p) => (p + 1) % PHASES.length), PHASE_MS);
    return () => clearInterval(t);
  }, [streaming]);

  const label = streaming ? (STEP_LABEL[phase!] ?? "Designing the architecture") : PHASES[rotated];
  // ~4 chars per token — a rough, honest "work happening" ticker, not a billed count.
  const approxTokens = chars && chars > 0 ? Math.round(chars / 4) : 0;

  return (
    <div className="drafting" role="status" aria-live="polite">
      <div className="drafting__blueprint" aria-hidden="true">
        <span className="drafting__node drafting__node--1" />
        <span className="drafting__node drafting__node--2" />
        <span className="drafting__node drafting__node--3" />
        <span className="drafting__sweep" />
      </div>
      <p className="drafting__title">Drafting your architecture…</p>
      <p className="drafting__phase">
        {label}…
        {approxTokens > 0 && <span className="drafting__ticker"> · ~{approxTokens} tokens</span>}
      </p>

      {items && items.length > 0 && (
        // The design building live — the last few completed elements, newest first.
        <ul className="drafting__items" aria-label="Design taking shape">
          {items
            .slice(-6)
            .reverse()
            .map((it, i) => (
              <li key={items.length - i} className={`drafting__item drafting__item--${it.kind}`}>
                <span className="drafting__item-glyph" aria-hidden="true">
                  {ITEM_GLYPH[it.kind]}
                </span>
                <span className="drafting__item-label">{it.label}</span>
                <span className="drafting__item-verb">{ITEM_VERB[it.kind]}</span>
              </li>
            ))}
        </ul>
      )}

      <p className="drafting__note">
        This usually takes under a minute — feel free to step away and come back.
      </p>
    </div>
  );
}
