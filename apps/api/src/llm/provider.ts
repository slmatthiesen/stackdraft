import type { GeneratedArchitecture, GeneratedTier, Clarification } from "../schema/architecture.js";
import type { GenerateScope } from "./generateScope.js";

export type { GenerateScope } from "./generateScope.js";

/**
 * Token accounting surfaced by every provider call so the SpendLedger can debit
 * actual usage (KTD7). `cacheReadTokens`/`cacheWriteTokens` track prompt-cache
 * economics (KTD11).
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderResult<T> {
  result: T;
  usage: Usage;
}

/**
 * A grounded prompt split at the prompt-cache breakpoint (KTD11):
 *  - `staticPrefix`  : system prompt + FULL security baselines. Cacheable —
 *                      identical every request, so it gets `cache_control`.
 *  - `volatileSuffix`: matched reference patterns + memory hits + user
 *                      description + answers. Varies per request — MUST come
 *                      after the breakpoint or the cache never hits.
 */
export interface GroundedPrompt {
  staticPrefix: string;
  volatileSuffix: string;
}

/** Cost ceiling for a single generation call. */
export interface GenerateOptions {
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

/**
 * Provider-abstracted LLM layer (KTD2/R13). V1 ships ClaudeProvider; a
 * GeminiProvider (V2) drops in behind this same interface without touching
 * callers.
 */
export interface LlmProvider {
  /** Decide whether clarification is needed (≤2 questions) before generating (R2). */
  clarify(description: string, priorAnswers?: string[]): Promise<ProviderResult<Clarification>>;

  /**
   * Generate the architecture as a validated typed graph (KTD3). The result OMITS the
   * security floor — that reusable knowledge is injected deterministically downstream
   * (see pipeline/securityFloor.ts), not generated.
   *
   * `scope` selects how MANY tiers are emitted (the lazy-per-tier cost/latency lever):
   * `budget` (default caller behavior — one tier), `addTier` (one tier as a delta vs a
   * budget baseline), or `full` (the original three tiers). Omitted → `full`, so the
   * evals / stress test that call `generate(prompt, opts)` keep the three-tier shape.
   * The returned `tiers` array is 1..3 accordingly.
   */
  generate(
    prompt: GroundedPrompt,
    opts?: GenerateOptions,
    scope?: GenerateScope,
  ): Promise<ProviderResult<GeneratedArchitecture>>;

  /**
   * Generate idiomatic, REFERENCE-ONLY Terraform (HCL) for a single tier of an
   * already-generated design — a starting point a human must review and harden,
   * not production-ready output (one best-fit artifact, generated on demand and
   * cached to respect the cost ceiling; not a multi-format export). Returns the
   * raw HCL (no prose, no markdown fences) plus usage so the ledger can debit the
   * call. Bounded by `opts.maxTokens` (provider picks a small default). Plain
   * text — NOT structured/json_schema output.
   */
  generateConfig(tier: GeneratedTier, opts?: { maxTokens?: number }): Promise<ProviderResult<string>>;

  /** Pre-flight input-token count for the hard input cap (U8). */
  countTokens(text: string): Promise<number>;
}

/** Typed error chain so callers can branch on retryability (claude-api skill). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ProviderError";
  }
}
