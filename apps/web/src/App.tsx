/**
 * U10 — the one page.
 *
 * Flow: a single textbox. On submit the prompt animates UP to become the page
 * header/goal (CSS transition driven by the `app--submitted` class), a loading
 * state shows, then either a ClarifyForm (R2) or the tiered results (R3) render
 * below. Error responses (rate-limited / budget-reached / too-large) surface as
 * friendly messages.
 */

import { useState } from "react";
import { generate, type ApiOutcome } from "./lib/api.js";
import { ClarifyForm } from "./components/ClarifyForm.js";
import { IntakeForm } from "./components/IntakeForm.js";
import { KeyDecisions } from "./components/KeyDecisions.js";
import { SecurityPanel } from "./components/SecurityPanel.js";
import { TierTabs } from "./components/TierTabs.js";
import type { GenerateResponse, TierName } from "./lib/types.js";

type Phase = "idle" | "intake" | "loading" | "clarify" | "result" | "error";

interface ClarifyState {
  questions: string[];
  round: number;
}

// Forcing a later round when the user has gone through intake tells the backend
// this is the final input — generate now, no model clarify round-trip (E6).
const INTAKE_ROUND = 2;

const TIER_DISPLAY: Record<TierName, string> = {
  budget: "Budget",
  balanced: "Balanced",
  resilient: "Resilient",
};

const ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "You're going a little fast — wait a moment and try again.",
  daily_cap_reached:
    "You've hit today's generation limit for your network. Please try again tomorrow.",
  daily_budget_reached:
    "The shared daily usage budget has been reached. Cached designs still work; full generation resumes tomorrow.",
  input_too_large: "That description is too long — please shorten it and try again.",
  network_error: "Couldn't reach the server. Check your connection and try again.",
};

function friendlyError(outcome: Extract<ApiOutcome, { kind: "error" }>): string {
  if (outcome.code.startsWith("turnstile")) {
    return "The bot check didn't pass. Refresh the page and try again.";
  }
  if (outcome.status === 400) {
    return outcome.message ?? "That request wasn't valid — please adjust your description.";
  }
  return ERROR_MESSAGES[outcome.code] ?? "Something went wrong. Please try again.";
}

export function App(): JSX.Element {
  const [draft, setDraft] = useState<string>("");
  const [goal, setGoal] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [clarifyState, setClarifyState] = useState<ClarifyState | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  // Remembered so the error "Try again" reissues the same generation.
  const [lastAttempt, setLastAttempt] = useState<{ answers?: string[]; round: number }>({
    round: 1,
  });

  const submitted = phase !== "idle";

  const applyOutcome = (outcome: ApiOutcome): void => {
    switch (outcome.kind) {
      case "clarify":
        setClarifyState({ questions: outcome.questions, round: outcome.round });
        setPhase("clarify");
        return;
      case "result":
        setResult({
          tiers: outcome.tiers,
          assumptions: outcome.assumptions,
          securityFloor: outcome.securityFloor,
          recommendedTier: outcome.recommendedTier,
          recommendationRationale: outcome.recommendationRationale,
          keyDecisions: outcome.keyDecisions,
        });
        setPhase("result");
        return;
      case "error":
        setErrorMessage(friendlyError(outcome));
        setPhase("error");
        return;
    }
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
    applyOutcome(await generate({ description, answers, round }));
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
    void startGeneration(goal, answers.length > 0 ? answers : undefined, INTAKE_ROUND);
  };

  const handleAnswers = async (answers: string[]): Promise<void> => {
    const round = clarifyState?.round ?? 1;
    setPhase("loading");
    applyOutcome(await generate({ description: goal, answers, round }));
  };

  return (
    <main className={`app ${submitted ? "app--submitted" : ""}`}>
      <header className="app__header">
        <span className="app__brand">Stackdraft</span>
        {submitted ? (
          <h1 className="app__goal">{goal}</h1>
        ) : (
          <p className="app__tagline">Describe a system — get a safe, costed AWS design.</p>
        )}
      </header>

      {!submitted && (
        <form className="prompt" onSubmit={handleSubmit} aria-label="Describe your system">
          <textarea
            className="prompt__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. A REST API for a photo-sharing app with image uploads and a feed…"
            rows={4}
            aria-label="System description"
          />
          <button type="submit" className="prompt__submit" disabled={!draft.trim()}>
            Design it
          </button>
        </form>
      )}

      {phase === "intake" && <IntakeForm onComplete={handleIntake} />}

      {phase === "loading" && (
        <p className="status" role="status">
          Designing a safe, costed AWS architecture…
        </p>
      )}

      {phase === "error" && (
        <div className="banner banner--error" role="alert">
          <p>{errorMessage}</p>
          <button
            type="button"
            onClick={() =>
              void startGeneration(goal, lastAttempt.answers, lastAttempt.round)
            }
          >
            Try again
          </button>
        </div>
      )}

      {phase === "clarify" && clarifyState && (
        <ClarifyForm questions={clarifyState.questions} onSubmit={(a) => void handleAnswers(a)} />
      )}

      {phase === "result" && result && (
        <>
          <section className="banner banner--recommend" role="note" aria-label="Recommendation">
            <p className="recommend__lead">
              Recommended: <strong>{TIER_DISPLAY[result.recommendedTier]}</strong>
            </p>
            {result.recommendationRationale && (
              <p className="recommend__why">{result.recommendationRationale}</p>
            )}
          </section>

          <SecurityPanel floor={result.securityFloor} />

          <KeyDecisions decisions={result.keyDecisions} />

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
          <TierTabs
            tiers={result.tiers}
            assumptions={result.assumptions}
            recommendedTier={result.recommendedTier}
          />
        </>
      )}
    </main>
  );
}
