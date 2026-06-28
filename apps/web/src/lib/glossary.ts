/**
 * Client-side term glossary (deterministic, no LLM).
 *
 * The term data is BUNDLED from the single source of truth — `@drafture/kb`'s
 * glossary.json — at build time (no runtime fetch), so the same curated
 * definitions ship with the app and there's nothing to keep in sync by hand.
 * {@link splitByTerms} tokenizes a string into plain + known-term parts so the UI
 * can render a hover tooltip on each known term.
 */
import glossaryData from "@drafture/kb/glossary.json";
import type { GlossaryTerm } from "@drafture/kb";

const TERMS = glossaryData as GlossaryTerm[];

/** Lowercased term → definition, for case-insensitive lookup on a match. */
const DEFINITION_BY_TERM = new Map<string, string>(
  TERMS.map((t) => [t.term.toLowerCase(), t.definition] as const),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One combined matcher, alternatives ordered LONGEST-first so a compound term
// (e.g. "Multi-AZ") wins over a shorter substring. Alphanumeric boundary
// lookarounds keep a term from matching inside a larger word ("IAM" ∉ "Miami").
const MATCHER = new RegExp(
  `(?<![A-Za-z0-9])(?:${TERMS.map((t) => t.term)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})(?![A-Za-z0-9])`,
  "gi",
);

export interface TextPart {
  text: string;
  /** Present when this part is a known glossary term — its definition. */
  definition?: string;
}

/** Split text into plain runs and known-term runs (for tooltip rendering). */
export function splitByTerms(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MATCHER)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: text.slice(last, idx) });
    const matched = m[0];
    parts.push({ text: matched, definition: DEFINITION_BY_TERM.get(matched.toLowerCase()) });
    last = idx + matched.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  if (parts.length === 0) parts.push({ text });
  return parts;
}
