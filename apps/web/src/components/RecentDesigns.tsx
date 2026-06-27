/**
 * "Recent designs" — past generations saved in the browser (see lib/history).
 * Re-opening one renders the stored design instantly with no server call ($0).
 *
 * Removal is destructive (no server copy to restore from), so both the per-item ✕
 * and "Clear all" ask for an inline confirmation before deleting.
 */
import { useState } from "react";
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
  // Which item's ✕ is awaiting confirmation (null = none), and the Clear-all confirm.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState<boolean>(false);

  if (entries.length === 0) return null;

  return (
    <section className="recents" aria-label="Recent designs">
      <div className="recents__head">
        <h2>Recent designs</h2>
        {confirmingClear ? (
          <span className="recents__confirm" role="group" aria-label="Confirm clearing all recent designs">
            <span className="recents__confirm-q">Clear all?</span>
            <button
              type="button"
              className="recents__confirm-yes"
              onClick={() => {
                onClear();
                setConfirmingClear(false);
                setConfirmingId(null);
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="recents__confirm-no"
              onClick={() => setConfirmingClear(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="recents__clear"
            onClick={() => {
              setConfirmingClear(true);
              setConfirmingId(null);
            }}
          >
            Clear all
          </button>
        )}
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
            {confirmingId === e.id ? (
              <span
                className="recents__confirm"
                role="group"
                aria-label={`Confirm removing "${e.prompt}"`}
              >
                <button
                  type="button"
                  className="recents__confirm-yes"
                  onClick={() => {
                    onRemove(e.id);
                    setConfirmingId(null);
                  }}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="recents__confirm-no"
                  onClick={() => setConfirmingId(null)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="recents__remove"
                aria-label={`Remove "${e.prompt}" from recent designs`}
                onClick={() => {
                  setConfirmingId(e.id);
                  setConfirmingClear(false);
                }}
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
