/** R7 — the safe-by-default security floor, stated ONCE and applied to every tier.
 *  Injected deterministically from the KB (the model never emits it). */

import { GlossaryText } from "./GlossaryText.js";

export function SecurityPanel({ floor }: { floor: string[] }): JSX.Element | null {
  if (floor.length === 0) return null;

  return (
    // Always open — the safe-by-default posture is worth seeing on every design,
    // so it's a plain section rather than a collapsible panel.
    <section className="card security" aria-label="Security floor">
      <h2 className="security__summary">
        Security floor (applied to every tier)
        <span className="security__count"> · {floor.length} controls</span>
      </h2>
      <ul>
        {floor.map((item, i) => (
          <li key={i}>
            <GlossaryText>{item}</GlossaryText>
          </li>
        ))}
      </ul>
    </section>
  );
}
