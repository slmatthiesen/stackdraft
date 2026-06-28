/** Subtle copy-to-clipboard control. Shows a transient "Copied" confirmation.
 *  `variant="icon"` renders a borderless clipboard glyph for tight slots (e.g.
 *  inside the description box); the default text variant is unchanged. */

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
  variant = "text",
}: {
  text: string;
  label?: string;
  variant?: "text" | "icon";
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (no permission / insecure context) — stay silent */
    }
  };

  if (variant === "icon") {
    // Icon-only: the accessible name comes from aria-label/title (swapped on copy),
    // not a text child, so it still announces for screen-reader users.
    const name = copied ? "Copied description" : "Copy description";
    return (
      <button
        type="button"
        className={`copy-btn copy-btn--icon${copied ? " copy-btn--copied" : ""}`}
        onClick={() => void copy()}
        aria-label={name}
        title={name}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M3 8.4l3.2 3.2L13 4.6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <rect
              x="3.5"
              y="3.4"
              width="9"
              height="11.1"
              rx="1.4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.3}
            />
            <rect
              x="5.6"
              y="1.4"
              width="4.8"
              height="2.6"
              rx="0.9"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.3}
            />
          </svg>
        )}
      </button>
    );
  }

  return (
    <button type="button" className="copy-btn" onClick={() => void copy()} aria-live="polite">
      {copied ? "Copied" : label}
    </button>
  );
}
