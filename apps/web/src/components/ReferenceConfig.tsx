/**
 * Per-tier reference Terraform, generated ON DEMAND. The HCL is fetched lazily
 * the first time the panel is opened and cached in state, so re-opening is
 * instant. Output is wrapped in a RED "reference only" banner — applying it to an
 * existing stack can lose data and it always needs review, never applied as-is.
 *
 * Syntax highlighting is a zero-dependency regex tokenizer (`lib/hcl-highlight`)
 * so this rarely-shown panel doesn't drag a highlighter into the bundle.
 */

import { useEffect, useRef, useState } from "react";
import type { Tier } from "../lib/types.js";
import { fetchConfig, type ConfigOutcome } from "../lib/api.js";
import { highlightHcl } from "../lib/hcl-highlight.js";
import { BudgetReachedNotice } from "./BudgetReachedNotice.js";
import { CopyButton } from "./CopyButton.js";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; code: string; format: string }
  | { status: "error"; message: string; errorCode: string };

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
  const [showHowTo, setShowHowTo] = useState(false);
  const howToRef = useRef<HTMLDivElement>(null);
  const tierLabel = TIER_LABEL[tier.name] ?? tier.name;

  // Escape closes the how-to overlay (same pattern as the SiteFooter info-modal);
  // focus moves into the panel so keyboard users land inside on open.
  useEffect(() => {
    if (!showHowTo) return;
    howToRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setShowHowTo(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHowTo]);

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const outcome = await fetchConfig(tier);
    if (outcome.kind === "config") {
      setState({ status: "ready", code: outcome.code, format: outcome.format });
    } else {
      setState({
        status: "error",
        message: friendlyConfigError(outcome),
        errorCode: outcome.code,
      });
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
        it changes with the tier you select above.{" "}
        <strong className="refconfig__reference-only">This is for reference only.</strong>
      </p>
      <p className="refconfig__meta">
        Written live by the model the first time you open it (a few seconds), then
        cached — reopening the same tier is instant and free.
      </p>
      <button
        type="button"
        className="refconfig__howto-link"
        onClick={() => setShowHowTo(true)}
      >
        How to use this Terraform →
      </button>
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

          {state.status === "error" &&
            (state.errorCode === "daily_budget_reached" ? (
              <BudgetReachedNotice />
            ) : (
              <div className="banner banner--error" role="alert">
                <p>{state.message}</p>
                <button type="button" onClick={() => void load()}>
                  Try again
                </button>
              </div>
            ))}

          {state.status === "ready" && (
            <div className="refconfig__result">
              <div className="banner banner--warn refconfig__warn" role="note">
                <div className="refconfig__warn-text">
                  <strong className="refconfig__reference-only">
                    ⚠ This is for reference only.
                  </strong>
                  <span>
                    Applying it to an <strong>existing stack can destroy or lose data</strong>{" "}
                    and would need to be modified to fit your current infrastructure. Even for a
                    greenfield project it must be reviewed first. It provisions{" "}
                    <strong>real, billable AWS resources</strong> — run <code>terraform plan</code>,
                    set a billing budget, and <code>terraform destroy</code> what you don't need.
                    You are responsible for all costs.
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
      {showHowTo && (
        <div
          className="info-modal"
          role="dialog"
          aria-modal="true"
          aria-label="How to use this Terraform"
          onClick={() => setShowHowTo(false)}
        >
          <button
            type="button"
            className="info-modal__close"
            onClick={() => setShowHowTo(false)}
            aria-label="Close"
          >
            ✕
          </button>
          <div
            className="info-modal__panel"
            ref={howToRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <HowToUseTerraformContent />
          </div>
        </div>
      )}
    </section>
  );
}

function HowToUseTerraformContent(): JSX.Element {
  return (
    <article className="info-doc">
      <h2>How to use this Terraform</h2>
      <p>
        Never used Terraform before? This walks through what the file in this panel is and how
        to apply it from scratch. It assumes a brand-new AWS project — and it's still a{" "}
        <strong>reference starting point</strong>, not production-ready.
      </p>

      <h3>What this file is</h3>
      <p>
        Terraform is an infrastructure-as-code tool: instead of clicking through the AWS
        console, you describe the resources you want — a bucket, a database, a Lambda function —
        in a declarative language called <strong>HCL</strong> in a text file, and Terraform
        creates, changes, and removes those resources to match the file. The code above is one
        such file.
      </p>

      <h3>Before you start</h3>
      <ul>
        <li>An <strong>AWS account</strong> (the free tier covers some, not all, resources).</li>
        <li>
          The <strong>Terraform CLI</strong> installed — <code>terraform -version</code> should
          print a version.
        </li>
        <li>
          <strong>AWS credentials</strong> on your machine, e.g. via <code>aws configure</code>.
        </li>
        <li>Save the code from this panel as a file named <code>main.tf</code> in an empty folder.</li>
      </ul>

      <h3>Apply it, step by step</h3>
      <p>From a terminal in that folder:</p>
      <ol>
        <li>
          <code>terraform init</code> — downloads the AWS provider. One-time per folder.
        </li>
        <li>
          <code>terraform plan</code> — shows exactly what it will create or change.{" "}
          <strong>Read it.</strong> This is your last safe checkpoint.
        </li>
        <li>Set a <strong>billing budget</strong> and cost alerts in AWS before going further.</li>
        <li>
          <code>terraform apply</code> — provisions the resources for real. Type <code>yes</code>{" "}
          to confirm.
        </li>
        <li>
          When you're done, <code>terraform destroy</code> tears it all down so you stop paying.
        </li>
      </ol>

      <h3>Stay safe</h3>
      <p>
        Applying provisions <strong>real, billable AWS resources</strong> in <em>your</em>{" "}
        account — you're responsible for every charge. Review the file first, prefer a fresh
        sandbox account, and <code>terraform destroy</code> anything you no longer need. Don't
        apply it against an existing stack without adapting it — it can overwrite or destroy data.
      </p>

      <p className="info-doc__note">
        Drafture never deploys anything and has no access to your account. Not affiliated with
        Amazon Web Services or HashiCorp.
      </p>
    </article>
  );
}
