/**
 * GLM (Zhipu / BigModel) provider — OpenAI-compatible `/chat/completions` over HTTP.
 *
 * Structured output uses FORCED FUNCTION-CALLING: the schema is registered as a
 * function and `tool_choice` is forced, so the API guarantees the response carries a
 * `tool_calls` entry whose `arguments` is valid JSON conforming to the schema. This
 * mirrors the Claude forced-tool-use path (same reliability, different transport)
 * and is the robust alternative to free-text "json mode", which weaker models wrap
 * in fences or prose. We read `arguments` and re-validate with the matching zod
 * schema before returning (defense in depth).
 *
 * No SDK dependency: the OpenAI-compatible endpoint is a plain JSON POST, so we use
 * global `fetch`. `fetchImpl` is injectable so tests mock it without the network.
 */
import type { z } from "zod";

import type { Config } from "../config.js";
import { GeneratedWireSchema, ClarificationSchema, reconstructTiers } from "../schema/architecture.js";
import type { GeneratedArchitecture, Clarification, GeneratedTier } from "../schema/architecture.js";
import { architectureToolSchema, clarificationToolSchema } from "./schema-utils.js";
import { ProviderError } from "./provider.js";
import type {
  GenerateOptions,
  GroundedPrompt,
  LlmProvider,
  ProviderResult,
  Usage,
} from "./provider.js";

export type FetchLike = typeof fetch;

export interface GlmSettings {
  apiKey: string;
  /** Base URL without a trailing slash, e.g. https://open.bigmodel.cn/api/paas/v4. */
  baseUrl: string;
  model: string;
  maxTokens: number;
}

interface FunctionDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const ARCHITECTURE_FN: FunctionDef = {
  type: "function",
  function: {
    name: "emit_architecture",
    description: "Emit the three-tier AWS architecture design as one structured object.",
    parameters: architectureToolSchema(),
  },
};

const CLARIFY_FN: FunctionDef = {
  type: "function",
  function: {
    name: "emit_clarification",
    description: "Emit the clarification verdict: whether questions are needed, and at most two.",
    parameters: clarificationToolSchema(),
  },
};

// Mirrors ClaudeProvider's plain-text prompts (kept local to avoid coupling the two
// providers; if these drift, align them). generateConfig is plain HCL, NOT structured.
const CLARIFY_SYSTEM = [
  "You are the clarification gate for an AWS architecture design tool.",
  "Given a system description, decide whether you need to ask the user anything",
  "before producing a safe, three-tier AWS design. Prefer to proceed: only ask",
  "when a genuinely load-bearing detail is missing. Ask at most two short questions.",
  "If the description is sufficient, return needsClarification=false with no questions.",
].join(" ");

const CONFIG_SYSTEM = [
  "You are an AWS architect writing REFERENCE-ONLY Terraform (HCL) for the following",
  "tier of a design. Output ONLY valid HCL, no prose, no markdown fences. It is a",
  "STARTING POINT a human must review and harden — not production-ready. Reflect the",
  "tier's services, the security controls (encryption, least-priv, private subnets),",
  "and any queue's DLQ. Keep it focused.",
].join(" ");

const CONFIG_MAX_TOKENS = 2500;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface GlmChoice {
  message?: { content?: string | null; tool_calls?: ToolCall[] };
  finish_reason?: string;
}

interface GlmResponse {
  choices?: GlmChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface ChatParams {
  model: string;
  max_tokens: number;
  messages: ChatMessage[];
  tools?: [FunctionDef] | [FunctionDef, FunctionDef];
  tool_choice?: { type: "function"; function: { name: string } };
  /** GLM-4.5 reasoning toggle. We DISABLE it for every call (see THINKING_OFF). */
  thinking?: { type: "enabled" | "disabled" };
}

/**
 * GLM-4.5 models reason by default, emitting a hidden chain-of-thought before the
 * answer. For our work the schema does the structuring, so that thinking adds large
 * decode latency (a single generation ran past undici's 300s header timeout) with no
 * quality gain — it only needs to fill a constrained tool schema, not deliberate. We
 * disable it on every call. Harmless on non-reasoning GLM models, which ignore it.
 */
const THINKING_OFF = { type: "disabled" } as const;

/**
 * GLM (OpenAI-compatible) implementation of the provider interface. Accepts an
 * injectable fetch so tests mock the transport without touching the network.
 */
export class GlmProvider implements LlmProvider {
  constructor(
    private readonly settings: GlmSettings,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  static fromConfig(config: Config, fetchImpl?: FetchLike): GlmProvider {
    return new GlmProvider(
      {
        // Required by the config refine when LLM_PROVIDER=glm (empty here only as a
        // type fallback; fromConfig is never called for glm without the key set).
        apiKey: config.GLM_API_KEY ?? "",
        baseUrl: config.GLM_BASE_URL,
        model: config.LLM_MODEL,
        maxTokens: config.LLM_MAX_TOKENS,
      },
      fetchImpl,
    );
  }

  async generate(
    prompt: GroundedPrompt,
    opts?: GenerateOptions,
  ): Promise<ProviderResult<GeneratedArchitecture>> {
    const maxTokens = opts?.maxTokens ?? this.settings.maxTokens;
    // The model emits the tier-delta WIRE shape; reconstruct full tiers here so
    // callers always receive a complete GeneratedArchitecture.
    const { result: wire, usage } = await this.structuredCall(
      {
        model: this.settings.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: prompt.staticPrefix },
          { role: "user", content: prompt.volatileSuffix },
        ],
        tools: [ARCHITECTURE_FN],
        tool_choice: { type: "function", function: { name: ARCHITECTURE_FN.function.name } },
        thinking: THINKING_OFF,
      },
      GeneratedWireSchema,
    );
    return { result: reconstructTiers(wire), usage };
  }

  async clarify(description: string, priorAnswers?: string[]): Promise<ProviderResult<Clarification>> {
    return this.structuredCall(
      {
        model: this.settings.model,
        max_tokens: 1024,
        messages: [
          { role: "system", content: CLARIFY_SYSTEM },
          { role: "user", content: buildClarifyInput(description, priorAnswers) },
        ],
        tools: [CLARIFY_FN],
        tool_choice: { type: "function", function: { name: CLARIFY_FN.function.name } },
        thinking: THINKING_OFF,
      },
      ClarificationSchema,
    );
  }

  async generateConfig(tier: GeneratedTier, opts?: { maxTokens?: number }): Promise<ProviderResult<string>> {
    const maxTokens = opts?.maxTokens ?? CONFIG_MAX_TOKENS;
    const res = await this.callChat({
      model: this.settings.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: CONFIG_SYSTEM },
        { role: "user", content: buildConfigInput(tier) },
      ],
      thinking: THINKING_OFF,
    });
    return { result: stripHclFence(res.text), usage: res.usage };
  }

  /**
   * GLM's OpenAI-compatible API has no token-count endpoint. Rough estimate
   * (~4 chars/token) is sufficient for the input-budget guard, which only needs an
   * upper bound — it never feeds billing (the actual call's reported usage does).
   */
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  /**
   * Run a forced-function-call and validate the result. On a parse/validation
   * failure we retry exactly once (a fresh call); a second failure throws a
   * non-retryable ProviderError. HTTP/transport errors are mapped and never
   * retried here (429/5xx are flagged retryable for an outer caller).
   */
  private async structuredCall<T>(
    params: ChatParams,
    schema: z.ZodType<T>,
  ): Promise<ProviderResult<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let parsed: unknown;
      let usage: Usage;
      try {
        const res = await this.callChat(params);
        parsed = parseToolArguments(res.choice, params);
        usage = res.usage;
      } catch (err) {
        if (err instanceof ProviderError) throw err; // transport/HTTP error — never retry here
        lastError = err;
        continue;
      }
      try {
        return { result: schema.parse(parsed), usage };
      } catch (err) {
        lastError = err;
      }
    }
    throw new ProviderError(
      `GLM response failed schema validation after one retry: ${describe(lastError)}`,
      false,
      lastError,
    );
  }

  /** One POST to /chat/completions; maps HTTP/transport errors to ProviderError. */
  private async callChat(params: ChatParams): Promise<{ choice: GlmChoice; text: string; usage: Usage }> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw new ProviderError(`GLM connection error: ${describe(err)}`, true, err);
    }

    if (!resp.ok) {
      const retryable = resp.status === 429 || resp.status >= 500;
      let detail = "";
      try {
        const body = (await resp.json()) as GlmResponse;
        detail = body.error?.message ?? "";
      } catch {
        /* ignore non-JSON error bodies */
      }
      throw new ProviderError(`GLM API error (${resp.status}): ${detail || resp.statusText}`, retryable);
    }

    let body: GlmResponse;
    try {
      body = (await resp.json()) as GlmResponse;
    } catch (err) {
      throw new ProviderError(`GLM returned a non-JSON response: ${describe(err)}`, false, err);
    }

    const choice = body.choices?.[0];
    if (!choice || !choice.message) {
      throw new ProviderError("GLM returned no choices", false);
    }
    const usage = mapUsage(body.usage);
    return { choice, text: choice.message.content ?? "", usage };
  }
}

/** Pull the forced function call's arguments out of the choice and JSON-parse them. */
function parseToolArguments(choice: GlmChoice, params: ChatParams): unknown {
  const expected = params.tools?.[0]?.function.name;
  const call = choice.message?.tool_calls?.find((t) => t.function.name === expected) ?? choice.message?.tool_calls?.[0];
  if (!call) throw new Error("model did not emit the required function call");
  try {
    return JSON.parse(call.function.arguments);
  } catch (err) {
    throw new Error(`function arguments were not valid JSON: ${describe(err)}`);
  }
}

function buildClarifyInput(description: string, priorAnswers?: string[]): string {
  if (!priorAnswers || priorAnswers.length === 0) return description;
  const answers = priorAnswers.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return `${description}\n\nPrior answers:\n${answers}`;
}

function buildConfigInput(tier: GeneratedTier): string {
  const payload = {
    name: tier.name,
    summary: tier.summary,
    nodes: tier.nodes.map((n) => ({ awsService: n.awsService, role: n.role, security: n.security })),
    edges: tier.edges.map((e) => ({ from: e.from, to: e.to, payload: e.payload, protocol: e.protocol })),
  };
  return JSON.stringify(payload, null, 2);
}

/** Concatenate text and strip a stray ```hcl fence so callers always get raw HCL. */
function stripHclFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:hcl|terraform)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function mapUsage(usage: GlmResponse["usage"]): Usage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: 0, // GLM OpenAI-compatible usage has no cache-token fields
    cacheWriteTokens: 0,
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
