/**
 * The community-gallery browser — fetch + filter + sort + vote over operator-approved
 * designs. Extracted from `GalleryView` so the SAME browser renders on the `/gallery`
 * page AND inline on the landing page beneath the curated examples (pass `initialLimit`
 * there to show a preview with a "Show all" toggle instead of the full list).
 *
 * Two filter rows over the same stored `tags` array: DOMAINS (the use-case axis a
 * visitor actually browses by — e-commerce, chat, notifications…) and FACETS (the
 * capability axis — compute, data…). Both mirror `apps/api/src/pipeline/tags.ts` by
 * hand (same manual-mirror contract as `lib/types.ts`). A design matches when it carries
 * ANY selected tag (forgiving OR); an empty selection shows everything.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchDesigns, voteDesign } from "../lib/api.js";
import type { DesignSummary, TierName } from "../lib/types.js";

// Mirror of `DOMAINS` in apps/api/src/pipeline/tags.ts (display order), with UI labels.
const DOMAINS: { tag: string; label: string }[] = [
  { tag: "ecommerce", label: "E-commerce" },
  { tag: "chat", label: "Chat" },
  { tag: "notifications", label: "Notifications" },
  { tag: "media", label: "Media" },
  { tag: "webhooks", label: "Webhooks" },
  { tag: "iot", label: "IoT" },
  { tag: "data-pipeline", label: "Data pipeline" },
  { tag: "static-site", label: "Static site" },
  { tag: "api-backend", label: "API backend" },
];

// Mirror of `FACETS` in apps/api/src/pipeline/tags.ts (display order).
const FACETS = [
  "compute",
  "data",
  "messaging",
  "api",
  "realtime",
  "security",
  "robustness",
  "observability",
] as const;

const TIER_LABEL: Record<TierName, string> = {
  budget: "Budget",
  balanced: "Balanced",
  resilient: "Resilient",
};

const VOTE_KEY = "drafture.designs.votes.v1";

type VoteValue = 1 | -1;
type Sort = "score" | "recent";

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

interface GalleryBrowserProps {
  /** When set, show only this many designs until the user expands (landing preview). */
  initialLimit?: number;
}

export function GalleryBrowser({ initialLimit }: GalleryBrowserProps): JSX.Element {
  const navigate = useNavigate();
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>("score");
  const [showAll, setShowAll] = useState(false);
  // Live counts (seeded from the list, updated on each successful vote).
  const [counts, setCounts] = useState<Record<string, { up: number; down: number }>>({});
  const [myVotes, setMyVotes] = useState<Record<string, VoteValue>>(() => loadLocalVotes());
  const [votingId, setVotingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchDesigns().then((list) => {
      if (!live) return;
      setDesigns(list);
      setCounts(
        Object.fromEntries(list.map((d) => [d.id, { up: d.upvotes, down: d.downvotes }])),
      );
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, []);

  const toggleFacet = (facet: string): void => {
    setShowAll(true); // a filter change should reveal all matches, not just the preview slice
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(facet)) next.delete(facet);
      else next.add(facet);
      return next;
    });
  };

  // Only surface a domain chip if at least one loaded design carries it — hides empty
  // buckets so the type row reflects what's actually browsable.
  const presentDomains = useMemo(() => {
    const present = new Set(designs.flatMap((d) => d.tags));
    return DOMAINS.filter((d) => present.has(d.tag));
  }, [designs]);

  const sorted = useMemo(() => {
    const filtered =
      active.size === 0
        ? designs
        : designs.filter((d) => d.tags.some((t) => active.has(t)));
    const out = [...filtered];
    if (sort === "recent") {
      out.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      out.sort((a, b) => {
        const sa = (counts[a.id]?.up ?? a.upvotes) - (counts[a.id]?.down ?? a.downvotes);
        const sb = (counts[b.id]?.up ?? b.upvotes) - (counts[b.id]?.down ?? b.downvotes);
        return sb - sa || b.createdAt - a.createdAt;
      });
    }
    return out;
  }, [designs, active, sort, counts]);

  const truncated = initialLimit != null && !showAll && sorted.length > initialLimit;
  const visible = truncated ? sorted.slice(0, initialLimit) : sorted;

  const castVote = async (id: string, value: VoteValue): Promise<void> => {
    setVotingId(id);
    try {
      const result = await voteDesign(id, value);
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
    <>
      {presentDomains.length > 0 && (
        <div className="gallery__filters" role="group" aria-label="Browse by type">
          <span className="gallery__filter-label">Type</span>
          {presentDomains.map(({ tag, label }) => {
            const on = active.has(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`tag-chip ${on ? "tag-chip--on" : ""}`}
                aria-pressed={on}
                onClick={() => toggleFacet(tag)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      <div className="gallery__filters" role="group" aria-label="Filter by capability">
        <span className="gallery__filter-label">Capability</span>
        {FACETS.map((facet) => {
          const on = active.has(facet);
          return (
            <button
              key={facet}
              type="button"
              className={`tag-chip ${on ? "tag-chip--on" : ""}`}
              aria-pressed={on}
              onClick={() => toggleFacet(facet)}
            >
              {facet}
            </button>
          );
        })}
      </div>

      <div className="gallery__sortbar">
        <span className="gallery__count">
          {sorted.length} {sorted.length === 1 ? "design" : "designs"}
        </span>
        <div className="gallery__sort" role="group" aria-label="Sort designs">
          <button
            type="button"
            className={`tag-chip ${sort === "score" ? "tag-chip--on" : ""}`}
            aria-pressed={sort === "score"}
            onClick={() => setSort("score")}
          >
            Top rated
          </button>
          <button
            type="button"
            className={`tag-chip ${sort === "recent" ? "tag-chip--on" : ""}`}
            aria-pressed={sort === "recent"}
            onClick={() => setSort("recent")}
          >
            Newest
          </button>
        </div>
      </div>

      {loading ? (
        <p className="gallery__sub" role="status">
          Loading designs…
        </p>
      ) : visible.length === 0 ? (
        <p className="gallery__sub">
          {designs.length === 0
            ? "No community designs yet — generate one and it'll appear here once approved."
            : "No designs match these filters — clear one to see more."}
        </p>
      ) : (
        <>
          <ul className="gallery__list">
            {visible.map((d) => {
              const c = counts[d.id] ?? { up: d.upvotes, down: d.downvotes };
              const mine = myVotes[d.id];
              const voting = votingId === d.id;
              return (
                <li key={d.id} className="gallery__item">
                  <button
                    type="button"
                    className="gallery__open"
                    onClick={() => navigate(`/design/${encodeURIComponent(d.id)}`)}
                    title={d.description}
                  >
                    <span className="gallery__name">{d.description}</span>
                    <span className="gallery__tags">
                      <span className="tag-chip tag-chip--tier">
                        {TIER_LABEL[d.recommendedTier] ?? d.recommendedTier}
                      </span>
                      {d.tags.map((t) => (
                        <span key={t} className="tag-chip tag-chip--mini">
                          {t}
                        </span>
                      ))}
                    </span>
                  </button>
                  <span className="gallery__votes" role="group" aria-label="Rate this design">
                    <button
                      type="button"
                      className={`gallery__vote ${mine === 1 ? "gallery__vote--on" : ""}`}
                      aria-label="Upvote design"
                      aria-pressed={mine === 1}
                      disabled={voting}
                      onClick={() => void castVote(d.id, 1)}
                    >
                      ▲ {c.up}
                    </button>
                    <button
                      type="button"
                      className={`gallery__vote ${mine === -1 ? "gallery__vote--on" : ""}`}
                      aria-label="Downvote design"
                      aria-pressed={mine === -1}
                      disabled={voting}
                      onClick={() => void castVote(d.id, -1)}
                    >
                      ▼ {c.down}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {truncated && (
            <button type="button" className="gallery__showall" onClick={() => setShowAll(true)}>
              Show all {sorted.length} designs →
            </button>
          )}
        </>
      )}
    </>
  );
}
