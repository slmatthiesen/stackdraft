/**
 * E6 — a compact, SKIPPABLE 3-question intake shown once before generation.
 *
 * Quick chip/radio options only (no free text), one screen, no back-and-forth.
 * Selected answers become labeled strings ("Expected traffic: millions a day")
 * passed as `answers` to /api/generate; skipping passes none. Either way the
 * parent forces a final round so there's no model clarify round-trip.
 */

import { useState } from "react";

interface Question {
  /** Stable key used to build the labeled answer string. */
  id: string;
  label: string;
  prompt: string;
  options: string[];
}

// Scale is no longer asked here — it's the Low/Medium/High tier ladder on the
// result (Medium pre-selected). These two questions shape the DESIGN itself
// (availability target + compliance), which the tiers don't express.
const QUESTIONS: Question[] = [
  {
    id: "downtime",
    label: "Downtime tolerance",
    prompt: "How bad is downtime?",
    options: ["Best-effort", "Important", "Mission-critical"],
  },
  {
    id: "data",
    label: "Data sensitivity",
    prompt: "Regulated data or multi-tenant?",
    options: ["No", "Regulated (HIPAA/PCI/etc.)", "Multi-tenant SaaS", "Not sure"],
  },
];

export function IntakeForm({
  onComplete,
}: {
  /** Receives labeled answer strings; an empty array means the user skipped. */
  onComplete: (answers: string[]) => void;
}): JSX.Element {
  const [selected, setSelected] = useState<Record<string, string>>({});

  const choose = (id: string, option: string): void => {
    setSelected((prev) => ({ ...prev, [id]: option }));
  };

  const design = (): void => {
    const answers = QUESTIONS.filter((q) => selected[q.id]).map(
      (q) => `${q.label}: ${selected[q.id]}`,
    );
    onComplete(answers);
  };

  return (
    <section className="card intake" aria-label="Quick intake">
      <h2>To tailor the design, answer 2 quick questions — or skip for sensible, scalable defaults.</h2>
      <div className="intake__questions">
        {QUESTIONS.map((q) => (
          <fieldset key={q.id} className="intake__question">
            <legend>{q.prompt}</legend>
            <div className="intake__chips" role="radiogroup" aria-label={q.prompt}>
              {q.options.map((option) => {
                const active = selected[q.id] === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`intake__chip ${active ? "intake__chip--active" : ""}`}
                    onClick={() => choose(q.id, option)}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="intake__actions">
        <button type="button" className="intake__skip" onClick={() => onComplete([])}>
          Skip
        </button>
        <button type="button" className="intake__design" onClick={design}>
          Design it
        </button>
      </div>
    </section>
  );
}
