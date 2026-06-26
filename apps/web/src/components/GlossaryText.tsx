/**
 * Renders a string with two enhancements:
 *  - any KNOWN glossary term is wrapped in an <abbr> with a hover/focus tooltip;
 *  - any PARENTHETICAL aside "(…)" is bolded, so the clarifying detail stands out.
 * Plain runs render as bare text so surrounding text stays a single node.
 */
import { Fragment, type ReactNode } from "react";
import { splitByTerms } from "../lib/glossary.js";

/** Render a plain string with glossary terms wrapped in <abbr>. */
function renderGlossary(text: string, keyPrefix: string): ReactNode[] {
  return splitByTerms(text).map((p, i) =>
    p.definition ? (
      // data-tip drives the CSS tooltip (instant + reliable, unlike the native
      // title attr). tabIndex makes it keyboard-focusable so the tip shows on focus.
      <abbr key={`${keyPrefix}-${i}`} className="gloss" tabIndex={0} data-tip={p.definition}>
        {p.text}
      </abbr>
    ) : (
      <Fragment key={`${keyPrefix}-${i}`}>{p.text}</Fragment>
    ),
  );
}

const PARENS = /\(([^()]*)\)/g;

export function GlossaryText({ children }: { children: string }): JSX.Element {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  PARENS.lastIndex = 0;
  while ((m = PARENS.exec(children)) !== null) {
    if (m.index > last) nodes.push(...renderGlossary(children.slice(last, m.index), `o${k}`));
    nodes.push(
      <strong key={`b${k}`} className="bracketed">
        ({renderGlossary(m[1] ?? "", `i${k}`)})
      </strong>,
    );
    last = m.index + m[0].length;
    k++;
  }
  if (last < children.length) nodes.push(...renderGlossary(children.slice(last), `o${k}`));
  return <>{nodes}</>;
}
