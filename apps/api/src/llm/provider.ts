import type { ArchitectureResult, Clarification } from "../schema/architecture.js";

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

  /** Generate the three-tier architecture as a validated typed graph (KTD3). */
  generate(prompt: GroundedPrompt, opts?: GenerateOptions): Promise<ProviderResult<ArchitectureResult>>;

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
