/**
 * Renders a string, wrapping any KNOWN glossary term in an <abbr> that shows a
 * hover/focus tooltip with its definition (native title + styled underline).
 * Plain runs render as bare text so the surrounding text stays a single node.
 */
import { Fragment } from "react";
import { splitByTerms } from "../lib/glossary.js";

export function GlossaryText({ children }: { children: string }): JSX.Element {
  const parts = splitByTerms(children);
  return (
    <>
      {parts.map((p, i) =>
        p.definition ? (
          <abbr key={i} className="gloss" title={p.definition}>
            {p.text}
          </abbr>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
