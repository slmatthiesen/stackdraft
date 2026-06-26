/** R7 — the safe-by-default security floor, stated ONCE and applied to every tier. */

export function SecurityPanel({ floor }: { floor: string[] }): JSX.Element | null {
  if (floor.length === 0) return null;

  return (
    <section className="card security" aria-label="Security floor">
      <h2>Security floor (applied to every tier)</h2>
      <ul>
        {floor.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
