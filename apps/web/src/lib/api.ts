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
  KeyDecision,
  Tier,
  TierName,
} from "./types.js";

export interface GenerateRequest {
  description: string;
  answers?: string[];
  round?: number;
  turnstileToken?: string;
}

/** Discriminated union the UI switches on — never throws for HTTP/transport errors. */
export type ApiOutcome =
  | { kind: "clarify"; questions: string[]; round: number }
  | {
      kind: "result";
      tiers: Tier[];
      assumptions: string[];
      securityFloor: string[];
      recommendedTier: TierName;
      recommendationRationale: string;
      keyDecisions: KeyDecision[];
    }
  | { kind: "error"; status: number; code: string; message?: string };

/** Discriminated result of `/api/config` — never throws. */
export type ConfigOutcome =
  | { kind: "config"; format: string; code: string }
  | { kind: "error"; status: number; code: string; message?: string };

const ENDPOINT = "/api/generate";
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
    tiers,
    assumptions: result.assumptions ?? [],
    securityFloor: result.securityFloor ?? [],
    // Defaults keep the UI resilient if the backend omits the new fields.
    recommendedTier: result.recommendedTier ?? tiers[0]?.name ?? "balanced",
    recommendationRationale: result.recommendationRationale ?? "",
    keyDecisions: result.keyDecisions ?? [],
  };
}

/** Resubmit answers to advance a clarification round — same endpoint as {@link generate}. */
export const clarify = generate;

/**
 * Generate a tier's reference Terraform ON DEMAND (`/api/config`). Slower than a
 * tier render, so the UI calls this lazily on first expand and caches the result.
 * Returns a discriminated outcome and never throws for HTTP/transport errors.
 */
export async function fetchConfig(
  tier: Tier,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfigOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(CONFIG_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier }),
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

function isClarify(data: unknown): data is ClarifyResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { needsClarification?: unknown }).needsClarification === true
  );
}
