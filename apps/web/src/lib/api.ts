/**
 * Typed client for the single `/api/generate` endpoint.
 *
 * The endpoint is overloaded: an initial call may come back asking for
 * clarification (R2), and the answer-resubmit hits the SAME endpoint with
 * `answers` + an advanced `round`. `generate` and `clarify` are therefore the
 * same call — `clarify` is just the semantically-named alias for the resubmit.
 *
 * `fetch` is injectable so tests can pass a stub without touching globals.
 */

import type {
  GenerateResponse,
  ClarifyResponse,
  ConfigResponse,
  CuratedSummary,
  CuratedRunFull,
  DesignFull,
  DesignSummary,
  KeyDecision,
  Tier,
  TierName,
} from "./types.js";

export interface GenerateRequest {
  description: string;
  answers?: string[];
  round?: number;
  turnstileToken?: string;
  /** Force a fresh generation, bypassing the learning-network instant-serve. */
  freshOnly?: boolean;
}

/** Discriminated union the UI switches on — never throws for HTTP/transport errors. */
export type ApiOutcome =
  | { kind: "clarify"; questions: string[]; round: number }
  | {
      kind: "result";
      /** Persisted-generation id — present when the server stored the design. */
      id?: string;
      tiers: Tier[];
      assumptions: string[];
      securityFloor: string[];
      recommendedTier: TierName;
      recommendationRationale: string;
      keyDecisions: KeyDecision[];
      /** Set when the design was served from the learning network rather than freshly generated. */
      fromLibrary?: { basedOnPrompt: string; similarity: number };
    }
  | { kind: "error"; status: number; code: string; message?: string };

/** Discriminated result of `/api/config` — never throws. */
export type ConfigOutcome =
  | { kind: "config"; format: string; code: string }
  | { kind: "error"; status: number; code: string; message?: string };

/** Discriminated result of `/api/generate/tier` (+ Add tier) — never throws. */
export type AddTierOutcome =
  | { kind: "tier"; tier: Tier }
  | { kind: "error"; status: number; code: string; message?: string };

const ENDPOINT = "/api/generate";
const ADD_TIER_ENDPOINT = "/api/generate/tier";
const CONFIG_ENDPOINT = "/api/config";

export async function generate(
  body: GenerateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error", status: 0, code: "network_error" };
  }

  // Errors carry { error } (and 400 also { message }); a body may be absent.
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body — leave data null and fall through to code-by-status */
  }

  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; message?: string };
    return {
      kind: "error",
      status: res.status,
      code: obj.error ?? "unknown_error",
      message: obj.message,
    };
  }

  if (isClarify(data)) {
    return { kind: "clarify", questions: data.questions, round: data.round };
  }

  const result = (data ?? {}) as Partial<GenerateResponse>;
  const tiers = result.tiers ?? [];
  return {
    kind: "result",
    id: result.id,
    tiers,
    assumptions: result.assumptions ?? [],
    securityFloor: result.securityFloor ?? [],
    // Defaults keep the UI resilient if the backend omits the new fields.
    recommendedTier: result.recommendedTier ?? tiers[0]?.name ?? "balanced",
    recommendationRationale: result.recommendationRationale ?? "",
    keyDecisions: result.keyDecisions ?? [],
    fromLibrary: result.fromLibrary,
  };
}

/** Resubmit answers to advance a clarification round — same endpoint as {@link generate}. */
export const clarify = generate;

export interface AddTierRequest {
  description: string;
  answers?: string[];
  round?: number;
  /** Which tier to add — balanced or resilient (budget comes from the initial generate). */
  tier: TierName;
  /** The already-generated budget tier — the baseline the new tier is a delta of. */
  budgetTier: Tier;
  /** Persisted-generation id so the added tier is merged into its stored body. */
  generationId?: string;
  turnstileToken?: string;
}

/**
 * Add ONE tier (balanced/resilient) to a budget-first design on demand
 * (`/api/generate/tier`, fix A). The server generates just that tier as a delta vs the
 * budget baseline, prices it, and returns the single costed tier for the UI to append.
 * Never throws for HTTP/transport errors.
 */
export async function addTier(
  body: AddTierRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AddTierOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(ADD_TIER_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error", status: 0, code: "network_error" };
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body — fall through to code-by-status */
  }

  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; message?: string };
    return { kind: "error", status: res.status, code: obj.error ?? "unknown_error", message: obj.message };
  }

  const obj = (data ?? {}) as { tier?: Tier };
  if (!obj.tier) return { kind: "error", status: res.status, code: "malformed_response" };
  return { kind: "tier", tier: obj.tier };
}

/**
 * Generate a tier's reference Terraform ON DEMAND (`/api/config`). Slower than a
 * tier render, so the UI calls this lazily on first expand and caches the result.
 * Returns a discriminated outcome and never throws for HTTP/transport errors.
 */
export async function fetchConfig(
  tier: Tier,
  generationId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfigOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(CONFIG_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // generationId activates the server's lazy Terraform persist: the first pull on
      // a stored design pays, every later pull (this id, this tier) is a free DB read.
      body: JSON.stringify(generationId ? { tier, generationId } : { tier }),
    });
  } catch {
    return { kind: "error", status: 0, code: "network_error" };
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body — leave data null and fall through to code-by-status */
  }

  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; message?: string };
    return {
      kind: "error",
      status: res.status,
      code: obj.error ?? "unknown_error",
      message: obj.message,
    };
  }

  const cfg = (data ?? {}) as Partial<ConfigResponse>;
  return { kind: "config", format: cfg.format ?? "terraform", code: cfg.code ?? "" };
}

const CURATED_ENDPOINT = "/api/curated";

/** List the curated gallery. Returns [] on any error — the gallery is optional UI. */
export async function fetchCurated(fetchImpl: typeof fetch = fetch): Promise<CuratedSummary[]> {
  try {
    const res = await fetchImpl(CURATED_ENDPOINT);
    if (!res.ok) return [];
    const data = (await res.json()) as { runs?: CuratedSummary[] };
    return data.runs ?? [];
  } catch {
    return [];
  }
}

/** Fetch one curated run's full design. Returns null on error/unknown id. */
export async function fetchCuratedRun(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CuratedRunFull | null> {
  try {
    const res = await fetchImpl(`${CURATED_ENDPOINT}/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return (await res.json()) as CuratedRunFull;
  } catch {
    return null;
  }
}

const DESIGNS_ENDPOINT = "/api/designs";

/** List the approved community gallery. Returns [] on any error — the gallery is optional UI. */
export async function fetchDesigns(fetchImpl: typeof fetch = fetch): Promise<DesignSummary[]> {
  try {
    const res = await fetchImpl(DESIGNS_ENDPOINT);
    if (!res.ok) return [];
    const data = (await res.json()) as { designs?: DesignSummary[] };
    return data.designs ?? [];
  } catch {
    return [];
  }
}

/** Cast an up (+1) or down (-1) vote on a community design. Returns new counts, or null on error. */
export async function voteDesign(
  id: string,
  value: 1 | -1,
  fetchImpl: typeof fetch = fetch,
): Promise<{ upvotes: number; downvotes: number } | null> {
  try {
    const res = await fetchImpl(`${DESIGNS_ENDPOINT}/${encodeURIComponent(id)}/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { upvotes: number; downvotes: number };
  } catch {
    return null;
  }
}

/**
 * Load a deep-linked design for `/design/:id`. Tries the generation-gallery endpoint
 * first; a curated example lives in its own store (separate ids), so on a 404 we fall
 * back to the curated fetch and normalize it to the same shape. One id space, one
 * renderer — no duplicated design data on the server. Returns null on unknown id.
 */
export async function fetchDesign(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesignFull | null> {
  try {
    const res = await fetchImpl(`${DESIGNS_ENDPOINT}/${encodeURIComponent(id)}`);
    if (res.ok) return (await res.json()) as DesignFull;
  } catch {
    /* transport error — fall through to the curated source */
  }
  const curated = await fetchCuratedRun(id, fetchImpl);
  if (!curated) return null;
  return { id: curated.id, prompt: curated.prompt, design: curated.design };
}

/** Cast an up (+1) or down (-1) vote. Returns the new counts, or null on error. */
export async function voteCurated(
  id: string,
  value: 1 | -1,
  fetchImpl: typeof fetch = fetch,
): Promise<{ upvotes: number; downvotes: number } | null> {
  try {
    const res = await fetchImpl(`${CURATED_ENDPOINT}/${encodeURIComponent(id)}/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { upvotes: number; downvotes: number };
  } catch {
    return null;
  }
}

const FEEDBACK_ENDPOINT = "/api/feedback";

export interface FeedbackRequest {
  description: string;
  answers?: string[];
  round?: number;
  rating: 1 | -1;
}

/**
 * Submit a thumbs-up (+1) / thumbs-down (-1) on the current result. The server re-derives
 * the prompt hash from {description, answers, round} so the verdict ties to the exact
 * design that was shown. Returns the recorded rating, or null on transport/HTTP error.
 */
export async function submitFeedback(
  body: FeedbackRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ rating: 1 | -1 } | null> {
  try {
    const res = await fetchImpl(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as { rating: 1 | -1 };
  } catch {
    return null;
  }
}

function isClarify(data: unknown): data is ClarifyResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { needsClarification?: unknown }).needsClarification === true
  );
}
