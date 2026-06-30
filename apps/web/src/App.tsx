/**
 * U10 — the one page, now routed.
 *
 * `/` is the landing flow: a single textbox whose prompt animates UP to become the
 * page header/goal (CSS `app--submitted`), a loading state, then either a ClarifyForm
 * (R2) or the tiered results (R3) below. A FRESH generation renders inline in local
 * state — no route change mid-generation, so the prompt-animates-up UX is intact.
 *
 * `/design/:id` is a real, shareable, reload-safe deep link. Opening a curated example
 * or a saved design navigates there (pushing browser history, so Back returns to the
 * landing page instead of leaving the site) and the SAME <DesignResult> renderer draws
 * it — the only difference is deep-linked designs render without the feedback thumbs.
 */

import { useEffect, useState } from "react";
import { Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
import {
  generate,
  fetchCurated,
  fetchDesign,
  submitFeedback,
  type ApiOutcome,
} from "./lib/api.js";
import { BudgetReachedNotice } from "./components/BudgetReachedNotice.js";
import { ClarifyForm } from "./components/ClarifyForm.js";
import { CopyButton } from "./components/CopyButton.js";
import { CuratedGallery } from "./components/CuratedGallery.js";
import { DesignResult } from "./components/DesignResult.js";
import { GalleryView } from "./components/GalleryView.js";
import { IntakeForm } from "./components/IntakeForm.js";
import { LoadingDraft } from "./components/LoadingDraft.js";
import { RecentDesigns } from "./components/RecentDesigns.js";
import { SiteFooter } from "./components/SiteFooter.js";
import type {
  CuratedSummary,
  DesignFull,
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

/** Top-level router: one route per renderable surface. */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/gallery" element={<GalleryView />} />
      <Route path="/design/:id" element={<DesignPage />} />
    </Routes>
  );
}

function Home(): JSX.Element {
  const navigate = useNavigate();
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
  // True until the first curated fetch settles — drives a skeleton so the gallery
  // space is reserved instead of popping in after the round-trip (the blank-then-fill flash).
  const [curatedLoading, setCuratedLoading] = useState<boolean>(true);
  // Thumbs-up/down on the current (fresh-generation-only) result. Feedback keys off the
  // generation's prompt inputs (goal + lastAttempt), so it only ever rides a result we
  // produced here — re-opened designs deep-link to /design/:id and render without it.
  const [feedbackRating, setFeedbackRating] = useState<1 | -1 | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);

  // Load the curated gallery once on mount; failures degrade to no gallery.
  useEffect(() => {
    void fetchCurated()
      .then(setCurated)
      .finally(() => setCuratedLoading(false));
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
          id: outcome.id,
          tiers: outcome.tiers,
          assumptions: outcome.assumptions,
          securityFloor: outcome.securityFloor,
          recommendedTier: outcome.recommendedTier,
          recommendationRationale: outcome.recommendationRationale,
          keyDecisions: outcome.keyDecisions,
          fromLibrary: outcome.fromLibrary,
        };
        setResult(response);
        setSelectedTier(response.recommendedTier);
        setFeedbackRating(null);
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

  // Re-open a saved design: hand the stored body to /design/:id via router state so
  // it renders instantly with no fetch ($0), while the URL still becomes shareable and
  // Back-button-correct (a direct reload of that id falls back to the server fetch).
  const openSaved = (entry: HistoryEntry): void => {
    const payload: DesignFull = {
      id: entry.id,
      prompt: entry.prompt,
      design: entry.result,
    };
    navigate(`/design/${encodeURIComponent(entry.id)}`, { state: { design: payload } });
  };

  // Open a curated example: just navigate — /design/:id fetches the stored body
  // (curated lives in its own store; the loader falls back to it on a generation miss).
  const openCurated = (id: string): void => {
    navigate(`/design/${encodeURIComponent(id)}`);
  };

  const startGeneration = async (
    description: string,
    answers?: string[],
    round = 1,
    freshOnly = false,
  ): Promise<void> => {
    setGoal(description);
    setPhase("loading");
    setResult(null);
    setClarifyState(null);
    setErrorMessage("");
    setLastAttempt({ answers, round });
    applyOutcome(await generate({ description, answers, round, freshOnly }), description);
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

  // Return to the landing/gallery from a fresh result without a reload (no history entry
  // was pushed for an inline generation, so this resets local state directly).
  const backToStart = (): void => {
    setPhase("idle");
    window.requestAnimationFrame(() => {
      document
        .getElementById("gallery")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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

      {!submitted && <CuratedGallery entries={curated} loading={curatedLoading} onOpen={openCurated} />}

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
          {result.fromLibrary && (
            <div className="from-library" role="status">
              <p className="from-library__text">
                Served instantly from our library — this closely matches a design we've already
                worked through, so we reused it instead of regenerating.
              </p>
              <button
                type="button"
                className="from-library__fresh"
                onClick={() =>
                  void startGeneration(goal, lastAttempt.answers, lastAttempt.round, true)
                }
              >
                Generate a fresh design instead →
              </button>
            </div>
          )}
          <DesignResult
            result={result}
            selectedTier={selectedTier}
            onSelectTier={setSelectedTier}
            generationId={result.id}
            feedback={{
              rating: feedbackRating,
              busy: feedbackBusy,
              onRate: (r) => void submitResultFeedback(r),
            }}
          />
        </>
      )}

      <SiteFooter />
    </main>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: DesignFull }
  | { status: "missing" };

/**
 * `/design/:id` — a deep-linked design. Renders from router state when an in-app open
 * passed the body (instant, $0); otherwise (reload / shared link / new tab) fetches it.
 * Unknown/pending/hidden ids resolve to a friendly "isn't available" state.
 */
function DesignPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const passed = (location.state as { design?: DesignFull } | null)?.design;

  const [state, setState] = useState<LoadState>(
    passed ? { status: "ready", data: passed } : { status: "loading" },
  );
  const [selectedTier, setSelectedTier] = useState<TierName>(
    passed?.design.recommendedTier ?? "balanced",
  );
  const [goalExpanded, setGoalExpanded] = useState<boolean>(false);

  useEffect(() => {
    if (passed || !id) return;
    let live = true;
    void fetchDesign(id).then((data) => {
      if (!live) return;
      if (!data) {
        setState({ status: "missing" });
        return;
      }
      setState({ status: "ready", data });
      setSelectedTier(data.design.recommendedTier);
    });
    return () => {
      live = false;
    };
  }, [id, passed]);

  const goal = state.status === "ready" ? state.data.prompt : "";

  return (
    <main className="app app--submitted">
      <header className="app__header">
        <span className="app__brand">Drafture</span>
        <div className="app__header-actions">
          {/* Mirrors the browser Back button: both return to the landing page. */}
          <button type="button" className="result__back" onClick={() => navigate("/")}>
            ← All examples
          </button>
        </div>
        {state.status === "ready" && (
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
        )}
      </header>

      {state.status === "loading" && <LoadingDraft />}

      {state.status === "missing" && (
        <div className="banner banner--error" role="alert">
          <p>This design isn't available — it may be private or no longer exist.</p>
          <button type="button" onClick={() => navigate("/")}>
            Back to start
          </button>
        </div>
      )}

      {state.status === "ready" && (
        <DesignResult
          result={state.data.design}
          selectedTier={selectedTier}
          onSelectTier={setSelectedTier}
          generationId={state.data.id}
        />
      )}

      <SiteFooter />
    </main>
  );
}
