/**
 * The "drafting your architecture…" loading state (generation runs ~30–90s).
 *
 * A blueprint-style animation plus a rotating line of what the architect is doing,
 * so the wait reads as deliberate work, not a hang. role="status" keeps it
 * announced to assistive tech.
 */
import { useEffect, useState } from "react";

const PHASES = [
  "Reviewing your requirements",
  "Choosing the right AWS services",
  "Wiring the data flow",
  "Sizing and costing each tier",
  "Applying the security floor",
  "Weighing the trade-offs",
];

const PHASE_MS = 2200;

export function LoadingDraft(): JSX.Element {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setPhase((p) => (p + 1) % PHASES.length), PHASE_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="drafting" role="status" aria-live="polite">
      <div className="drafting__blueprint" aria-hidden="true">
        <span className="drafting__node drafting__node--1" />
        <span className="drafting__node drafting__node--2" />
        <span className="drafting__node drafting__node--3" />
        <span className="drafting__sweep" />
      </div>
      <p className="drafting__title">Drafting your architecture…</p>
      <p className="drafting__phase">{PHASES[phase]}…</p>
    </div>
  );
}
