/**
 * Per-tier reference Terraform, generated ON DEMAND. The HCL is fetched lazily
 * the first time the panel is opened and cached in state, so re-opening is
 * instant. Output is wrapped in a RED "reference only" banner — it is a starting
 * point to review and harden, never something to apply as-is.
 *
 * Syntax highlighting is a zero-dependency regex tokenizer (`lib/hcl-highlight`)
 * so this rarely-shown panel doesn't drag a highlighter into the bundle.
 */

import { useState } from "react";
import type { Tier } from "../lib/types.js";
import { fetchConfig, type ConfigOutcome } from "../lib/api.js";
import { highlightHcl } from "../lib/hcl-highlight.js";
import { CopyButton } from "./CopyButton.js";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; code: string; format: string }
  | { status: "error"; message: string };

const CONFIG_ERRORS: Record<string, string> = {
  rate_limited: "Going a little fast — wait a moment and try the reference setup again.",
  daily_cap_reached: "Today's generation limit for your network is reached. Try again tomorrow.",
  daily_budget_reached:
    "The shared daily usage budget is reached. Reference setups resume tomorrow.",
  input_too_large: "This design is too large to generate a reference config for.",
  network_error: "Couldn't reach the server. Check your connection and try again.",
};

function friendlyConfigError(outcome: Extract<ConfigOutcome, { kind: "error" }>): string {
  if (outcome.status === 400) {
    return outcome.message ?? "Couldn't generate a reference config for this design.";
  }
  if (outcome.status === 502) {
    return "The reference config came back malformed. Please try again.";
  }
  return CONFIG_ERRORS[outcome.code] ?? "Couldn't generate the reference config. Please try again.";
}

const TIER_LABEL: Record<string, string> = {
  budget: "Budget",
  balanced: "Balanced",
  resilient: "Resilient",
};

export function ReferenceConfig({ tier }: { tier: Tier }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const tierLabel = TIER_LABEL[tier.name] ?? tier.name;

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const outcome = await fetchConfig(tier);
    if (outcome.kind === "config") {
      setState({ status: "ready", code: outcome.code, format: outcome.format });
    } else {
      setState({ status: "error", message: friendlyConfigError(outcome) });
    }
  };

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    // Fetch only once, on first open; cached results stay in state thereafter.
    if (next && state.status === "idle") void load();
  };

  return (
    <section className="card refconfig" aria-label="Reference configuration">
      <h2 className="refconfig__title">Get the Terraform</h2>
      <p className="refconfig__lead">
        A reference infrastructure-as-code starter for the <strong>{tierLabel}</strong> tier —
        it changes with the tier you select above. Review and harden before applying.
      </p>
      <p className="refconfig__meta">
        Written live by the model the first time you open it (a few seconds), then
        cached — reopening the same tier is instant and free.
      </p>
      <button
        type="button"
        className="refconfig__toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? "Hide reference setup" : `Show ${tierLabel} Terraform`}
      </button>

      {open && (
        <div className="refconfig__body">
          {state.status === "loading" && (
            <p className="status" role="status">
              Generating reference Terraform…
            </p>
          )}

          {state.status === "error" && (
            <div className="banner banner--error" role="alert">
              <p>{state.message}</p>
              <button type="button" onClick={() => void load()}>
                Try again
              </button>
            </div>
          )}

          {state.status === "ready" && (
            <div className="refconfig__result">
              <div className="banner banner--warn refconfig__warn" role="note">
                <div className="refconfig__warn-text">
                  <strong>⚠ Reference only — do not apply blindly.</strong>
                  <span>
                    Running this provisions <strong>real, billable AWS resources</strong> in
                    your account. Estimates are not guarantees. Review it, run{" "}
                    <code>terraform plan</code>, set a billing budget, and{" "}
                    <code>terraform destroy</code> what you don't need. You are responsible for
                    all costs.
                  </span>
                </div>
                <CopyButton text={state.code} label="Copy" />
              </div>
              <pre className="refconfig__code" aria-label="Reference Terraform">
                <code
                  // Highlighted HTML is escaped inside highlightHcl before any markup.
                  dangerouslySetInnerHTML={{ __html: highlightHcl(state.code) }}
                />
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
