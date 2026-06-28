/**
 * Site footer + legal overlays.
 *
 * A persistent footer with "About" and "Terms & Disclaimer" links. Clicking one
 * opens a full-screen overlay (same pattern as the diagram modal: backdrop click
 * and Escape close it). No router — the panels are inline content, toggled by
 * state, so the app stays a single page.
 *
 * The Terms panel is the legal floor for going live: it states the tool is a
 * reference only, that applying its output provisions real billable cloud
 * resources at the user's own risk, and that everything is provided AS-IS with
 * no warranty. The strong, in-context cost warning lives on the Terraform panel
 * itself (ReferenceConfig); this is the durable, linkable version.
 */

import { useEffect, useState } from "react";

type Panel = "about" | "terms";

const GITHUB_URL = "https://github.com/slmatthiesen/drafture";
// Plain-language terms; not legal advice. Update if scope/providers change.
const EFFECTIVE_DATE = "June 26, 2026";

export function SiteFooter(): JSX.Element {
  const [panel, setPanel] = useState<Panel | null>(null);

  // Close the overlay on Escape, matching the diagram modal.
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  return (
    <>
      <footer className="site-footer">
        <span className="site-footer__mark">Drafture</span>
        <nav className="site-footer__links" aria-label="Site information">
          <button type="button" className="site-footer__link" onClick={() => setPanel("about")}>
            About
          </button>
          <button type="button" className="site-footer__link" onClick={() => setPanel("terms")}>
            Terms &amp; Disclaimer
          </button>
          <a className="site-footer__link" href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer noopener">
            Contact
          </a>
          <a className="site-footer__link" href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
        </nav>
        <p className="site-footer__fine">
          Reference designs only — not professional advice. Review before applying.
        </p>
      </footer>

      {panel && (
        <div
          className="info-modal"
          role="dialog"
          aria-modal="true"
          aria-label={panel === "about" ? "About Drafture" : "Terms and disclaimer"}
          onClick={() => setPanel(null)}
        >
          <button
            type="button"
            className="info-modal__close"
            onClick={() => setPanel(null)}
            aria-label="Close"
          >
            ✕
          </button>
          <div className="info-modal__panel" onClick={(e) => e.stopPropagation()}>
            {panel === "about" ? <AboutContent /> : <TermsContent />}
          </div>
        </div>
      )}
    </>
  );
}

function AboutContent(): JSX.Element {
  return (
    <article className="info-doc">
      <h2>About Drafture</h2>
      <p>
        Drafture turns a plain-English description of a system into a recommended,
        cost-estimated, security-baselined AWS architecture — the kind of first draft a
        senior cloud architect would sketch. Describe what you're building, answer three
        quick questions, and get an opinionated design across budget, balanced, and
        resilient tiers, with the reasoning behind the recommendation and reference
        Terraform you can build from.
      </p>
      <p>
        It's a personal project built by <strong>Steven</strong>, an independent
        full-stack and AI engineer, as an open-source showcase of practical
        AI-engineering technique. The source is on{" "}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
          GitHub
        </a>{" "}
        — issues and contributions welcome.
      </p>
      <p className="info-doc__note">
        Drafture is not affiliated with, endorsed by, or sponsored by Amazon Web
        Services or HashiCorp. AWS and Terraform are trademarks of their respective owners.
      </p>
    </article>
  );
}

function TermsContent(): JSX.Element {
  return (
    <article className="info-doc">
      <h2>Terms of Use &amp; Disclaimer</h2>
      <p className="info-doc__meta">Effective {EFFECTIVE_DATE}</p>

      <p>
        By using Drafture you agree to these terms. In plain language: this is a free,
        best-effort tool that produces <strong>reference designs only</strong>. It is not
        a substitute for professional judgment, and you use its output entirely at your
        own risk. This is not legal advice.
      </p>

      <h3>Reference only — review before you build</h3>
      <p>
        Every architecture, recommendation, cost estimate, and piece of Terraform or other
        infrastructure-as-code that Drafture generates is a <strong>starting point for a
        qualified engineer to review, test, and harden</strong>. It is not production-ready
        and may contain errors, insecure defaults, or choices unsuitable for your needs.
        Do not deploy it as-is.
      </p>

      <h3>You are responsible for all cloud costs</h3>
      <p>
        Running infrastructure-as-code (for example, <code>terraform apply</code>) provisions
        <strong> real, billable resources</strong> in your own cloud account. Drafture
        never deploys anything and has no access to your account — but if you apply its
        output, <strong>you alone are responsible for every charge that results</strong>,
        including charges from resources left running. Always run <code>terraform plan</code>{" "}
        and read it, set a billing budget and cost alerts, and run{" "}
        <code>terraform destroy</code> on anything you no longer need.
      </p>
      <p>
        Cost figures shown are <strong>rough order-of-magnitude estimates</strong>, not
        quotes or guarantees. Your actual bill depends on usage, region, data transfer, and
        pricing changes, and may be substantially higher.
      </p>

      <h3>No warranty</h3>
      <p>
        Drafture is provided <strong>“as is” and “as available,” without warranty of any
        kind</strong>, express or implied, including merchantability, fitness for a
        particular purpose, accuracy, and non-infringement. Output is generated by an AI
        model and may be incorrect, incomplete, or inconsistent.
      </p>

      <h3>Limitation of liability</h3>
      <p>
        To the maximum extent permitted by law, the creator of Drafture shall not be
        liable for any direct, indirect, incidental, consequential, or special damages —
        including cloud costs, lost data, security incidents, downtime, or lost profits —
        arising from your use of the tool or its output.
      </p>

      <h3>Acceptable use & privacy</h3>
      <p>
        Don't submit confidential information, personal data, credentials, or secrets in
        your descriptions. To generate a design, the text you enter is sent to our AI
        model provider for processing. Your recent designs are stored only in your own
        browser (local storage) and never leave your device except for the description sent
        at generation time. A bot-protection check (Cloudflare Turnstile) and basic rate
        limits guard the service.
      </p>

      <h3>Not professional advice</h3>
      <p>
        Drafture does not provide architectural, security, financial, or legal advice.
        Decisions about your infrastructure are yours; consult qualified professionals
        before acting on its output.
      </p>

      <p className="info-doc__note">
        These terms may change; continued use means you accept the current version.
        Not affiliated with Amazon Web Services or HashiCorp.
      </p>
    </article>
  );
}
