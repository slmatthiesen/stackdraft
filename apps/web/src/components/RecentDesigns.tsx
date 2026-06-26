/**
 * "Recent designs" — past generations saved in the browser (see lib/history).
 * Re-opening one renders the stored design instantly with no server call ($0).
 */
import type { HistoryEntry } from "../lib/history.js";

const TIER_LABEL: Record<string, string> = {
  budget: "Budget",
  balanced: "Balanced",
  resilient: "Resilient",
};

function formatWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function RecentDesigns({
  entries,
  onOpen,
  onRemove,
  onClear,
}: {
  entries: HistoryEntry[];
  onOpen: (entry: HistoryEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}): JSX.Element | null {
  if (entries.length === 0) return null;

  return (
    <section className="recents" aria-label="Recent designs">
      <div className="recents__head">
        <h2>Recent designs</h2>
        <button type="button" className="recents__clear" onClick={onClear}>
          Clear all
        </button>
      </div>
      <ul className="recents__list">
        {entries.map((e) => (
          <li key={e.id} className="recents__item">
            <button
              type="button"
              className="recents__open"
              onClick={() => onOpen(e)}
              title={e.prompt}
            >
              <span className="recents__prompt">{e.prompt}</span>
              <span className="recents__meta">
                {formatWhen(e.savedAt)} · {TIER_LABEL[e.result.recommendedTier] ?? e.result.recommendedTier}
                {" · free"}
              </span>
            </button>
            <button
              type="button"
              className="recents__remove"
              aria-label={`Remove "${e.prompt}" from recent designs`}
              onClick={() => onRemove(e.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
