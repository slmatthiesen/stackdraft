/**
 * "See how it works with these" — the curated example gallery.
 *
 * Server-stored example designs (admin-curated) that open instantly for $0 via the
 * same result view as a fresh generation. Visitors can up/down vote; the server
 * dedupes one vote per IP, and we also remember the local choice so the UI reflects
 * it across reloads and doesn't invite re-clicking.
 */
import { useState } from "react";
import { voteCurated } from "../lib/api.js";
import type { CuratedSummary } from "../lib/types.js";

const VOTE_KEY = "drafture.curated.votes.v1";

/** The curated run that designs THIS site's own deployment — featured above the list. */
const SELF_HOST_ID = "self-hosting-a-stateful-web-app";

type VoteValue = 1 | -1;

function loadLocalVotes(): Record<string, VoteValue> {
  try {
    const raw = localStorage.getItem(VOTE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, VoteValue>) : {};
  } catch {
    return {};
  }
}

function persistLocalVotes(votes: Record<string, VoteValue>): void {
  try {
    localStorage.setItem(VOTE_KEY, JSON.stringify(votes));
  } catch {
    /* best-effort */
  }
}

export function CuratedGallery({
  entries,
  onOpen,
}: {
  entries: CuratedSummary[];
  /** May be async (it fetches the stored design); the card shows a spinner until it settles. */
  onOpen: (id: string) => void | Promise<void>;
}): JSX.Element | null {
  // Live counts (seeded from the server list, updated on each successful vote).
  const [counts, setCounts] = useState<Record<string, { up: number; down: number }>>(() =>
    Object.fromEntries(entries.map((e) => [e.id, { up: e.upvotes, down: e.downvotes }])),
  );
  const [myVotes, setMyVotes] = useState<Record<string, VoteValue>>(() => loadLocalVotes());
  // Which card is mid-open (network fetch) and which row's vote is in flight — both drive
  // a pending indicator so a click isn't met with a dead second of nothing.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [votingId, setVotingId] = useState<string | null>(null);

  if (entries.length === 0) return null;

  const open = async (id: string): Promise<void> => {
    setOpeningId(id);
    try {
      await onOpen(id);
    } finally {
      setOpeningId(null);
    }
  };

  const castVote = async (id: string, value: VoteValue): Promise<void> => {
    setVotingId(id);
    try {
      const result = await voteCurated(id, value);
      if (!result) return;
      setCounts((prev) => ({ ...prev, [id]: { up: result.upvotes, down: result.downvotes } }));
      setMyVotes((prev) => {
        const next = { ...prev, [id]: value };
        persistLocalVotes(next);
        return next;
      });
    } finally {
      setVotingId(null);
    }
  };

  return (
    <section id="gallery" className="gallery" aria-label="Curated example designs">
      <h2 className="gallery__title">See how it works with these</h2>
      <p className="gallery__sub">Real designs we've generated — open one instantly, free.</p>
      {entries.some((e) => e.id === SELF_HOST_ID) && (
        <button
          type="button"
          className="gallery__featured"
          onClick={() => void open(SELF_HOST_ID)}
          disabled={openingId === SELF_HOST_ID}
          aria-busy={openingId === SELF_HOST_ID}
        >
          {openingId === SELF_HOST_ID ? (
            <>
              <span className="gallery__spinner" aria-hidden="true" /> Loading…
            </>
          ) : (
            <>
              <strong>This site is built on its own Drafture plan.</strong>
              <span className="gallery__featured-sub">See how it was designed →</span>
            </>
          )}
        </button>
      )}
      <ul className="gallery__list">
        {entries.map((e) => {
          const c = counts[e.id] ?? { up: e.upvotes, down: e.downvotes };
          const mine = myVotes[e.id];
          const opening = openingId === e.id;
          const voting = votingId === e.id;
          return (
            <li key={e.id} className="gallery__item">
              <button
                type="button"
                className="gallery__open"
                onClick={() => void open(e.id)}
                title={e.prompt}
                disabled={opening}
                aria-busy={opening}
              >
                <span className="gallery__name">{e.title}</span>
                <span className="gallery__meta">
                  {opening ? (
                    <>
                      <span className="gallery__spinner" aria-hidden="true" /> Loading…
                    </>
                  ) : (
                    e.tech || "Open · free"
                  )}
                </span>
              </button>
              <span className="gallery__votes" role="group" aria-label={`Rate ${e.title}`}>
                <button
                  type="button"
                  className={`gallery__vote ${mine === 1 ? "gallery__vote--on" : ""}`}
                  aria-label={`Upvote ${e.title}`}
                  aria-pressed={mine === 1}
                  disabled={voting}
                  onClick={() => void castVote(e.id, 1)}
                >
                  ▲ {c.up}
                </button>
                <button
                  type="button"
                  className={`gallery__vote ${mine === -1 ? "gallery__vote--on" : ""}`}
                  aria-label={`Downvote ${e.title}`}
                  aria-pressed={mine === -1}
                  disabled={voting}
                  onClick={() => void castVote(e.id, -1)}
                >
                  ▼ {c.down}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
