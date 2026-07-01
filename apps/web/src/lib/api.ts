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
  return toResultOutcome(data);
}

/** Map a `/api/generate` success body to the `result` outcome. Shared by the JSON and
 *  streaming clients so both stay in sync with the response shape. */
function toResultOutcome(data: unknown): ApiOutcome {
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

/** A design element that completed mid-stream (fix D) — shown as the design "builds". */
export interface StreamItem {
  kind: "node" | "decision" | "edge";
  label: string;
}

/** Live progress from a streaming generation (fix D). */
export interface GenerateStreamHandlers {
  /** A named pipeline phase started (preparing / generating / costing / saving). */
  onPhase?: (step: string) => void;
  /** Output-size heartbeat during the decode — a rough char count (≈ tokens × 4). */
  onToken?: (chars: number) => void;
  /** A design item (service / decision / edge) just completed in the stream. */
  onItem?: (item: StreamItem) => void;
}

/**
 * Streaming variant of {@link generate} (fix D): asks the server for Server-Sent Events
 * and reports real phase + token-heartbeat progress as they arrive, resolving to the
 * SAME {@link ApiOutcome} as `generate`. Falls back to JSON parsing if the server doesn't
 * stream (guards reject before the stream opens, or an old server). Never throws.
 */
export async function generateStream(
  body: GenerateRequest,
  handlers: GenerateStreamHandlers = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error", status: 0, code: "network_error" };
  }

  const ctype = res.headers?.get?.("content-type") ?? "";
  // A guard rejection (4xx/5xx) or a non-streaming server answers with JSON — parse it
  // exactly as the plain client would, so behavior is identical off the streaming path.
  if (!res.ok || !ctype.includes("text/event-stream") || !res.body) {
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
    if (isClarify(data)) return { kind: "clarify", questions: data.questions, round: data.round };
    return toResultOutcome(data);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let outcome: ApiOutcome | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    // Frames are separated by a blank line ("\n\n").
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const { event, data } = parseSseFrame(frame);
      if (!event) continue;
      if (event === "phase") handlers.onPhase?.(String((data as { step?: string }).step ?? ""));
      else if (event === "token") handlers.onToken?.(Number((data as { chars?: number }).chars ?? 0));
      else if (event === "item") {
        const it = data as StreamItem;
        if (it && it.label) handlers.onItem?.({ kind: it.kind, label: it.label });
      } else if (event === "result") outcome = toResultOutcome(data);
      else if (event === "clarify") {
        const c = data as { questions?: string[]; round?: number };
        outcome = { kind: "clarify", questions: c.questions ?? [], round: c.round ?? 0 };
      } else if (event === "error") {
        const e = data as { error?: string; message?: string };
        outcome = { kind: "error", status: 0, code: e.error ?? "unknown_error", message: e.message };
      }
    }
  }

  return outcome ?? { kind: "error", status: 0, code: "stream_incomplete" };
}

/** Parse one SSE frame into its event name + JSON-decoded data payload. */
function parseSseFrame(frame: string): { event?: string; data?: unknown } {
  let event: string | undefined;
  let dataRaw = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
  }
  let data: unknown = undefined;
  if (dataRaw) {
    try {
      data = JSON.parse(dataRaw);
    } catch {
      /* leave data undefined on a malformed frame */
    }
  }
  return { event, data };
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
