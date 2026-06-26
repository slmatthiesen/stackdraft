/**
 * ADR-style key-decisions card — the senior signal. Each entry reads as
 * decision → chosen (emphasized), the alternatives weighed, and the why.
 */

import type { KeyDecision } from "../lib/types.js";
import { GlossaryText } from "./GlossaryText.js";

export function KeyDecisions({ decisions }: { decisions: KeyDecision[] }): JSX.Element | null {
  if (decisions.length === 0) return null;

  return (
    <section className="card decisions" aria-label="Key architecture decisions">
      <h2>Key decisions</h2>
      <ol className="decisions__list">
        {decisions.map((d, i) => (
          <li key={i} className="decisions__item">
            <p className="decisions__head">
              <span className="decisions__decision">{d.decision}</span>
              {" — "}
              <strong className="decisions__chosen">{d.chosen}</strong>
            </p>
            {/* Alternatives are their OWN sentence, kept separate from the rationale. */}
            {d.alternativesConsidered.length > 0 && (
              <p className="decisions__alts">Alternatives: {d.alternativesConsidered.join(", ")}</p>
            )}
            <p className="decisions__why">
              <GlossaryText>{d.rationale}</GlossaryText>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
