/**
 * U11 — renders a Mermaid string to SVG client-side.
 *
 * The inline diagram fills the card width but a dense left-to-right flow can still
 * be small, so an "Expand" control opens a full-screen overlay where the same SVG
 * renders large and scrollable. jsdom can't run Mermaid's SVG renderer, so tests
 * mock the `mermaid` module.
 */

import { useEffect, useState } from "react";
import mermaid from "mermaid";

// Mermaid global init is idempotent but we only want it once per page load.
let initialized = false;
// Monotonic id source — Mermaid requires a unique DOM id per render call.
let renderSeq = 0;

export function DiagramView({ chart }: { chart: string }): JSX.Element {
  const [svg, setSvg] = useState<string>("");
  const [failed, setFailed] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);

  useEffect(() => {
    // React 18 StrictMode runs effects twice in dev; `cancelled` discards the
    // stale first pass so we never paint an out-of-date diagram.
    let cancelled = false;

    if (!initialized) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      initialized = true;
    }

    setFailed(false);
    const id = `sd-diagram-${renderSeq++}`;
    mermaid
      .render(id, chart)
      .then((out) => {
        if (!cancelled) setSvg(out.svg);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setSvg("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  // Close the overlay on Escape.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (failed) {
    return (
      <div className="diagram diagram--fallback" role="img" aria-label="Architecture diagram (source)">
        <p className="diagram__note">Diagram preview unavailable — showing the source graph:</p>
        <pre>{chart}</pre>
      </div>
    );
  }

  return (
    <>
      <div className="diagram" aria-label="Architecture diagram">
        {svg && (
          <button
            type="button"
            className="diagram__expand"
            onClick={() => setExpanded(true)}
            aria-label="Expand diagram"
          >
            ⤢ Expand
          </button>
        )}
        {/* svg is produced by Mermaid with securityLevel:'strict' (sanitized). */}
        <div className="diagram__svg" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>

      {expanded && (
        <div
          className="diagram-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Architecture diagram (expanded)"
          onClick={() => setExpanded(false)}
        >
          <button
            type="button"
            className="diagram-modal__close"
            onClick={() => setExpanded(false)}
            aria-label="Close expanded diagram"
          >
            ✕
          </button>
          <div
            className="diagram-modal__canvas"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </>
  );
}
