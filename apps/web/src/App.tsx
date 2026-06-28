/**
 * U10 — the one page.
 *
 * Flow: a single textbox. On submit the prompt animates UP to become the page
 * header/goal (CSS transition driven by the `app--submitted` class), a loading
 * state shows, then either a ClarifyForm (R2) or the tiered results (R3) render
 * below. Error responses (rate-limited / budget-reached / too-large) surface as
 * friendly messages.
 */

import { useEffect, useState } from "react";
import {
  generate,
  fetchCurated,
  fetchCuratedRun,
  submitFeedback,
  type ApiOutcome,
} from "./lib/api.js";
import { BudgetReachedNotice } from "./components/BudgetReachedNotice.js";
import { ClarifyForm } from "./components/ClarifyForm.js";
import { CopyButton } from "./components/CopyButton.js";
import { CuratedGallery } from "./components/CuratedGallery.js";
import { IntakeForm } from "./components/IntakeForm.js";
import { KeyDecisions } from "./components/KeyDecisions.js";
import { LoadingDraft } from "./components/LoadingDraft.js";
import { RecentDesigns } from "./components/RecentDesigns.js";
import { ReferenceConfig } from "./components/ReferenceConfig.js";
import { SecurityPanel } from "./components/SecurityPanel.js";
import { SiteFooter } from "./components/SiteFooter.js";
import { TierTabs } from "./components/TierTabs.js";
import type {
  CuratedSummary,
  GenerateResponse,
  TierName,
} from "./lib/types.js";
import {
  loadHistory,
  addHistory,
  removeHistory,
  clearHistory,
  type HistoryEntry,
} from "./lib/history.js";

type Phase = "idle" | "intake" | "loading" | "clarify" | "result" | "error";

interface ClarifyState {
  questions: string[];
  round: number;
}

// Forcing a later round when the user has gone through intake tells the backend
// this is the final input — generate now, no model clarify round-trip (E6).
const INTAKE_ROUND = 2;


const ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "You're going a little fast — wait a moment and try again.",
  daily_cap_reached:
    "You've hit today's generation limit for your network. Please try again tomorrow.",
  daily_budget_reached:
    "The shared daily usage budget has been reached. Cached designs still work; full generation resumes tomorrow.",
  input_too_large:
    "That description is too long — please shorten it and try again.",
  network_error:
    "Couldn't reach the server. Check your connection and try again.",
};

function friendlyError(
  outcome: Extract<ApiOutcome, { kind: "error" }>,
): string {
  if (outcome.code.startsWith("turnstile")) {
    return "The bot check didn't pass. Refresh the page and try again.";
  }
  if (outcome.status === 400) {
    return (
      outcome.message ??
      "That request wasn't valid — please adjust your description."
    );
  }
  return (
    ERROR_MESSAGES[outcome.code] ?? "Something went wrong. Please try again."
  );
}

export function App(): JSX.Element {
  const [draft, setDraft] = useState<string>("");
  const [goal, setGoal] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [clarifyState, setClarifyState] = useState<ClarifyState | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  // Tracked so the "out of funds" case gets its own friendly notice (with a way
  // to reach the operator) instead of the generic error banner + Try again.
  const [errorCode, setErrorCode] = useState<string>("");
  // Remembered so the error "Try again" reissues the same generation.
  const [lastAttempt, setLastAttempt] = useState<{
    answers?: string[];
    round: number;
  }>({
    round: 1,
  });
  // Past designs saved in this browser — re-openable instantly for $0.
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  // The echoed goal can be a long paragraph; clamp it to two lines by default
  // and let the user expand it so it doesn't dominate the top of the page.
  const [goalExpanded, setGoalExpanded] = useState<boolean>(false);
  // Active tier — lifted here (not inside TierTabs) so the page-bottom Terraform,
  // which is tier-specific, tracks the selected tab. Reset on each new result.
  const [selectedTier, setSelectedTier] = useState<TierName>("balanced");
  // Admin-curated example designs (server-stored) shown on the landing page.
  const [curated, setCurated] = useState<CuratedSummary[]>([]);
  // Thumbs-up/down on the current result. `feedbackFresh` is true only for results from a
  // real generation — feedback keys off the generation's prompt inputs (goal + lastAttempt),
  // which re-opened history/curated designs don't have, so it's hidden there in v1.
  const [feedbackRating, setFeedbackRating] = useState<1 | -1 | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackFresh, setFeedbackFresh] = useState(false);

  // Load the curated gallery once on mount; failures degrade to no gallery.
  useEffect(() => {
    void fetchCurated().then(setCurated);
  }, []);

  const submitted = phase !== "idle";

  const applyOutcome = (
    outcome: ApiOutcome,
    promptForHistory?: string,
  ): void => {
    switch (outcome.kind) {
      case "clarify":
        setClarifyState({ questions: outcome.questions, round: outcome.round });
        setPhase("clarify");
        return;
      case "result": {
        const response: GenerateResponse = {
          tiers: outcome.tiers,
          assumptions: outcome.assumptions,
          securityFloor: outcome.securityFloor,
          recommendedTier: outcome.recommendedTier,
          recommendationRationale: outcome.recommendationRationale,
          keyDecisions: outcome.keyDecisions,
        };
        setResult(response);
        setSelectedTier(response.recommendedTier);
        setFeedbackRating(null);
        setFeedbackFresh(true);
        setPhase("result");
        if (promptForHistory)
          setHistory(addHistory(promptForHistory, response));
        return;
      }
      case "error":
        setErrorCode(outcome.code);
        setErrorMessage(friendlyError(outcome));
        setPhase("error");
        return;
    }
  };

  // The gallery/recents sit far down the landing page; jump back to the top so the
  // opened design (recommendation banner first) is what the user lands on.
  const scrollToTop = (): void =>
    window.scrollTo({ top: 0, behavior: "smooth" });

  // Re-open a saved design: pure client-side, no fetch, $0.
  const openSaved = (entry: HistoryEntry): void => {
    setGoal(entry.prompt);
    setResult(entry.result);
    setSelectedTier(entry.result.recommendedTier);
    setClarifyState(null);
    setErrorMessage("");
    setFeedbackRating(null);
    setFeedbackFresh(false);
    setPhase("result");
    scrollToTop();
  };

  // Open a curated example: one cheap GET for the stored design, then render it
  // through the normal result view — no model call, no spend.
  const openCurated = async (id: string): Promise<void> => {
    const run = await fetchCuratedRun(id);
    if (!run) return;
    setGoal(run.prompt);
    setResult(run.design);
    setSelectedTier(run.design.recommendedTier);
    setClarifyState(null);
    setErrorMessage("");
    setFeedbackRating(null);
    setFeedbackFresh(false);
    setPhase("result");
    scrollToTop();
  };

  // Return to the landing/gallery from a result view without a page reload —
  // otherwise a visitor viewing a curated design has to refresh to browse the rest.
  const backToStart = (): void => {
    setPhase("idle");
    // Land on the gallery (rAF waits for the idle render to paint it first).
    window.requestAnimationFrame(() => {
      document
        .getElementById("gallery")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const startGeneration = async (
    description: string,
    answers?: string[],
    round = 1,
  ): Promise<void> => {
    setGoal(description);
    setPhase("loading");
    setResult(null);
    setClarifyState(null);
    setErrorMessage("");
    setLastAttempt({ answers, round });
    applyOutcome(await generate({ description, answers, round }), description);
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const description = draft.trim();
    if (!description) return;
    // Surface the quick intake (E6) before generating; goal animates into header.
    setGoal(description);
    setPhase("intake");
  };

  const handleIntake = (answers: string[]): void => {
    // Skip sends no answers; either way force a final round (no clarify trip).
    void startGeneration(
      goal,
      answers.length > 0 ? answers : undefined,
      INTAKE_ROUND,
    );
  };

  const handleAnswers = async (answers: string[]): Promise<void> => {
    const round = clarifyState?.round ?? 1;
    setPhase("loading");
    applyOutcome(await generate({ description: goal, answers, round }), goal);
  };

  // Send a thumbs-up/down on the just-generated design. The server re-derives the prompt
  // hash, so we send the original inputs (goal + lastAttempt), not the result itself.
  const submitResultFeedback = async (rating: 1 | -1): Promise<void> => {
    if (!result || feedbackBusy) return;
    setFeedbackBusy(true);
    const res = await submitFeedback({
      description: goal,
      answers: lastAttempt.answers,
      round: lastAttempt.round,
      rating,
    });
    setFeedbackBusy(false);
    if (res) setFeedbackRating(res.rating);
  };

  return (
    <main className={`app ${submitted ? "app--submitted" : ""}`}>
      <header className="app__header">
        <span className="app__brand">Drafture</span>
        {submitted && (
          <div className="app__header-actions">
            <button type="button" className="result__back" onClick={backToStart}>
              ← All examples
            </button>
          </div>
        )}
        {submitted ? (
          <h1 className="app__goal">
            <button
              type="button"
              className="app__goal-toggle"
              aria-expanded={goalExpanded}
              title={goalExpanded ? "Collapse" : "Show full description"}
              onClick={() => setGoalExpanded((v) => !v)}
            >
              <span className="app__goal-label" aria-hidden="true">
                Your description
              </span>
              <span className="app__goal-text">{goal}</span>
              <span className="app__goal-caret" aria-hidden="true">
                {goalExpanded ? "▲" : "▼"}
              </span>
            </button>
            <CopyButton text={goal} variant="icon" />
          </h1>
        ) : (
          <p className="app__tagline">
            Describe a system — get a safe, costed AWS design
            <br />
            from an agent trained on AWS architecture.
          </p>
        )}
      </header>

      {!submitted && (
        <form
          className="prompt"
          onSubmit={handleSubmit}
          aria-label="Describe your system"
        >
          <textarea
            className="prompt__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. A REST API for a photo-sharing app with image uploads and a feed…"
            rows={4}
            aria-label="System description"
          />
          <button
            type="submit"
            className="prompt__submit"
            disabled={!draft.trim()}
          >
            Design it
          </button>
        </form>
      )}

      {!submitted && (
        <section className="preview" aria-label="What you'll get">
          <h2 className="preview__title">You get...</h2>
          <ul className="preview__list">
            <li className="preview__item">
              <span className="preview__icon" aria-hidden="true">
                ◇
              </span>
              <div>
                <strong>An architecture diagram</strong> — a clear visual of how
                the services connect, rendered from a Mermaid graph you can
                export.
              </div>
            </li>
            <li className="preview__item">
              <span className="preview__icon" aria-hidden="true">
                ≣
              </span>
              <div>
                <strong>Three costed tiers with the reasoning</strong> — budget,
                balanced, and resilient designs, each with a cost estimate, a
                security baseline, and the key decisions behind the recommended
                choice.
              </div>
            </li>
            <li className="preview__item">
              <span className="preview__icon" aria-hidden="true">
                {"</>"}
              </span>
              <div>
                <strong>Reference Terraform</strong> — infrastructure-as-code
                you can pull into your project and review with your coding agent
                before going live, or compare against your current AWS setup.
              </div>
            </li>
          </ul>
        </section>
      )}

      {!submitted && <CuratedGallery entries={curated} onOpen={openCurated} />}

      {!submitted && (
        <RecentDesigns
          entries={history}
          onOpen={openSaved}
          onRemove={(id) => setHistory(removeHistory(id))}
          onClear={() => setHistory(clearHistory())}
        />
      )}

      {phase === "intake" && <IntakeForm onComplete={handleIntake} />}

      {phase === "loading" && <LoadingDraft />}

      {phase === "error" &&
        (errorCode === "daily_budget_reached" ? (
          <BudgetReachedNotice />
        ) : (
          <div className="banner banner--error" role="alert">
            <p>{errorMessage}</p>
            <button
              type="button"
              onClick={() =>
                void startGeneration(
                  goal,
                  lastAttempt.answers,
                  lastAttempt.round,
                )
              }
            >
              Try again
            </button>
          </div>
        ))}

      {phase === "clarify" && clarifyState && (
        <ClarifyForm
          questions={clarifyState.questions}
          onSubmit={(a) => void handleAnswers(a)}
        />
      )}

      {phase === "result" && result && (
        <>
          {/* Diagram leads: the tier tabs (Budget/Balanced/Resilient, Balanced
              pre-selected) sit at the top so the design is visible immediately. */}
          <TierTabs
            tiers={result.tiers}
            assumptions={result.assumptions}
            selected={selectedTier}
            onSelect={setSelectedTier}
          />

          {/* Useful-design rating sits just above the key decisions — after the
              reader has seen the diagram, before the reasoning. */}
          {feedbackFresh && (
            <section className="banner banner--recommend">
              <div
                className="recommend__feedback"
                role="group"
                aria-label="Rate this design"
              >
                <span className="recommend__feedback-label">Useful design?</span>
                <button
                  type="button"
                  className={`recommend__thumb recommend__thumb--up${feedbackRating === 1 ? " recommend__thumb--on" : ""}`}
                  aria-label="Good design"
                  aria-pressed={feedbackRating === 1}
                  disabled={feedbackBusy}
                  onClick={() => void submitResultFeedback(1)}
                >
                  👍
                </button>
                <button
                  type="button"
                  className={`recommend__thumb recommend__thumb--down${feedbackRating === -1 ? " recommend__thumb--on" : ""}`}
                  aria-label="Needs improvement"
                  aria-pressed={feedbackRating === -1}
                  disabled={feedbackBusy}
                  onClick={() => void submitResultFeedback(-1)}
                >
                  👎
                </button>
              </div>
            </section>
          )}

          <KeyDecisions decisions={result.keyDecisions} />

          <SecurityPanel floor={result.securityFloor} />

          {result.assumptions.length > 0 && (
            <section className="card assumptions" aria-label="Assumptions">
              <h2>Assumptions</h2>
              <ul>
                {result.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}

          {/* Terraform last: read the design, security floor, and assumptions
              first, then grab the tier-specific reference file. */}
          <ReferenceConfig
            tier={
              result.tiers.find((t) => t.name === selectedTier) ??
              result.tiers[0]!
            }
          />
        </>
      )}

      <SiteFooter />
    </main>
  );
}
