import Anthropic, { APIConnectionError, APIError, RateLimitError } from "@anthropic-ai/sdk";
import type { z } from "zod";

import type { Config } from "../config.js";
import { ClarificationSchema } from "../schema/architecture.js";
import type { GeneratedArchitecture, Clarification, GeneratedTier } from "../schema/architecture.js";
import { clarificationToolSchema } from "./schema-utils.js";
import { resolveGenerateScope, type GenerateScope } from "./generateScope.js";
import { StreamItemScanner } from "./streamScanner.js";
import type { GenerateProgress } from "./provider.js";
import { renderTerraformWireupRules } from "./configPrompt.js";
import { ProviderError } from "./provider.js";
import type {
  GenerateOptions,
  GroundedPrompt,
  LlmProvider,
  ProviderResult,
  Usage,
} from "./provider.js";

/**
 * Structured output is delivered via FORCED TOOL USE: the architecture /
 * clarification JSON Schema is registered as a tool and `tool_choice` is forced,
 * so the API guarantees the response is a `tool_use` block whose `input` is valid
 * JSON conforming to the schema. We read `input` and re-validate with the matching
 * zod schema before returning (defense in depth).
 *
 * WHY not native `output_config.format` (json_schema): it is NOT enforced for our
 * model — the API returns free-form text (sometimes a fenced ```graphql block),
 * which `messages.parse()` rejects, and the request 502s. Tool use is enforced
 * regardless of model, so it is reliable on both Sonnet and Haiku.
 */

/**
 * Above this `max_tokens` a non-streaming request risks the SDK's HTTP timeout
 * (claude-api skill), so we stream and collect the final message instead. The
 * streamed message isn't auto-parsed, so the structured output is read from its
 * text block (see {@link extractStructuredOutput}).
 */
const STREAMING_THRESHOLD = 16_000;

/**
 * Default output budget for a reference-config call. Deliberately small: the
 * artifact is one focused, reference-only Terraform file for a single tier, and a
 * tight ceiling keeps the on-demand generation cheap against the $5/day budget.
 */
const CONFIG_MAX_TOKENS = 2500;

const CONFIG_SYSTEM = [
  "You are an AWS architect writing REFERENCE-ONLY Terraform (HCL) for the following",
  "tier of a design. Output ONLY valid HCL, no prose, no markdown fences. It is a",
  "STARTING POINT a human must review and harden — not production-ready. Reflect the",
  "tier's services, the security controls (encryption, least-priv, private subnets),",
  "and any queue's DLQ. Keep it focused.",
].join(" ");

const CLARIFY_SYSTEM = [
  "You are the clarification gate for an AWS architecture design tool.",
  "Given a system description, decide whether you need to ask the user anything",
  "before producing a safe, three-tier AWS design. Prefer to proceed: only ask",
  "when a genuinely load-bearing detail is missing (e.g. expected traffic shape,",
  "data sensitivity, or a hard constraint). Ask at most two short questions. If",
  "the description is sufficient, return needsClarification=false with no questions.",
].join(" ");

/** Tool the model MUST call to emit its clarification verdict (forced tool use). */
const CLARIFY_TOOL = {
  name: "emit_clarification",
  description: "Emit the clarification verdict: whether questions are needed, and at most two.",
  input_schema: clarificationToolSchema() as Anthropic.Tool.InputSchema,
};

interface ClaudeSettings {
  model: string;
  maxTokens: number;
  /**
   * Generation effort. Currently INERT: forced tool use has no effort knob, so
   * this is read from config but not sent. Kept so a future provider or a move
   * back to native structured output can use it without a config-schema change.
   */
  effort: "low" | "medium" | "high";
}

/**
 * Provider-abstracted Claude implementation (KTD2). Accepts an injected
 * Anthropic client so tests can mock the SDK without touching the network.
 */
export class ClaudeProvider implements LlmProvider {
  constructor(
    private readonly client: Anthropic,
    private readonly settings: ClaudeSettings,
  ) {}

  /** Build from validated config; the launch default model is claude-sonnet-4-6 (KTD2). */
  static fromConfig(config: Config, client?: Anthropic): ClaudeProvider {
    const resolved = client ?? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    return new ClaudeProvider(resolved, {
      model: config.LLM_MODEL,
      maxTokens: config.LLM_MAX_TOKENS,
      effort: config.LLM_EFFORT,
    });
  }

  async generate(
    prompt: GroundedPrompt,
    opts?: GenerateOptions,
    scope?: GenerateScope,
  ): Promise<ProviderResult<GeneratedArchitecture>> {
    const maxTokens = opts?.maxTokens ?? this.settings.maxTokens;
    // The scope picks the tool (budget-only / add-one-tier / full three) so the model
    // emits only what's asked — the lazy-per-tier cost/latency lever.
    const resolved = resolveGenerateScope(scope);
    const userText = resolved.extraUserContent
      ? `${prompt.volatileSuffix}\n\n${resolved.extraUserContent}`
      : prompt.volatileSuffix;
    // KTD11: the cache breakpoint sits ONLY on the static prefix (system prompt
    // + full security baselines). The volatile suffix follows in the user turn
    // with no cache_control, so the per-request content never poisons the key.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.settings.model,
      max_tokens: maxTokens,
      system: [
        {
          type: "text",
          text: prompt.staticPrefix,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      // Forced tool use: the API guarantees the tool_use `input` is valid JSON
      // conforming to the schema. Reliable on Sonnet AND Haiku — unlike
      // output_config.format, which is not enforced for our model.
      tools: [
        {
          name: resolved.toolName,
          description: resolved.toolDescription,
          input_schema: resolved.toolSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: resolved.toolName },
    };

    // The model emits a WIRE shape (per scope); reconstruct the tier(s) here so
    // callers always receive a complete GeneratedArchitecture (1..3 tiers).
    const { result: wire, usage } = await this.structuredCall(params, resolved.wireSchema, opts?.onProgress);
    return { result: resolved.reconstruct(wire), usage };
  }

  async clarify(
    description: string,
    priorAnswers?: string[],
  ): Promise<ProviderResult<Clarification>> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.settings.model,
      max_tokens: 1024,
      system: CLARIFY_SYSTEM,
      messages: [{ role: "user", content: buildClarifyInput(description, priorAnswers) }],
      tools: [CLARIFY_TOOL],
      tool_choice: { type: "tool", name: CLARIFY_TOOL.name },
    };

    return this.structuredCall(params, ClarificationSchema);
  }

  async generateConfig(
    tier: GeneratedTier,
    opts?: { maxTokens?: number },
  ): Promise<ProviderResult<string>> {
    const maxTokens = opts?.maxTokens ?? CONFIG_MAX_TOKENS;
    // KTD11: cache_control sits ONLY on the static system prefix (identical every
    // call); the per-tier content rides in the user turn with no cache_control so
    // the per-request payload never poisons the cache key.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.settings.model,
      max_tokens: maxTokens,
      system: [
        {
          type: "text",
          text: CONFIG_SYSTEM + "\n\n" + renderTerraformWireupRules(),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: buildConfigInput(tier) }] }],
    };

    return this.textCall(params);
  }

  async countTokens(text: string): Promise<number> {
    try {
      const res = await this.client.messages.countTokens({
        model: this.settings.model,
        messages: [{ role: "user", content: text }],
      });
      return res.input_tokens;
    } catch (err) {
      throw mapError(err);
    }
  }

  /**
   * Run a native structured-output call and validate the result. The server
   * already constrains the response to the JSON Schema, but we re-validate with
   * the matching zod schema (defense in depth). On a parse/validation failure we
   * retry exactly once (a fresh model call); a second failure throws a
   * non-retryable ProviderError. API/transport errors propagate immediately
   * (mapped in `mapError`) and are never retried here.
   */
  private async structuredCall<T>(
    params: Anthropic.MessageCreateParamsNonStreaming,
    schema: z.ZodType<T>,
    onProgress?: (p: GenerateProgress) => void,
  ): Promise<ProviderResult<T>> {
    let lastError: unknown;

    // Weaker/cheaper models (e.g. Haiku) intermittently malform the forced-tool
    // output two ways: (1) JSON-encode a nested field as a STRING ("tiers": "[...]"),
    // (2) omit a required field entirely. (1) is repaired in-place (parse stringified
    // JSON before validating); (2) is non-recoverable from one response, so we give a
    // few fresh attempts — a clean retry usually succeeds. Caveat: frequent retries
    // erode a cheap model's cost advantage (each attempt is billed).
    for (let attempt = 0; attempt < 3; attempt++) {
      let message: Anthropic.Message;
      try {
        message = await this.callModel(params, onProgress);
      } catch (err) {
        // API/transport failures (from create/stream) are mapped and thrown
        // immediately, never retried. Any other throw falls through to retry.
        if (isApiFailure(err)) throw mapError(err);
        lastError = err;
        continue;
      }

      if (message.stop_reason === "refusal") {
        throw new ProviderError("Model refused the request", false, message.stop_reason);
      }

      const candidate = (() => {
        try {
          return extractStructuredOutput(message);
        } catch (err) {
          lastError = err;
          return undefined;
        }
      })();
      if (candidate === undefined) continue;

      // First try as-is; on failure, retry the SAME response with stringified-JSON
      // fields coerced, before spending another model call.
      for (const value of [candidate, repairStructured(candidate)]) {
        try {
          return { result: schema.parse(value), usage: mapUsage(message.usage) };
        } catch (err) {
          lastError = err;
        }
      }
    }

    throw new ProviderError(
      `Model response failed schema validation after retries: ${describe(lastError)}`,
      false,
      lastError,
    );
  }

  private async callModel(
    params: Anthropic.MessageCreateParamsNonStreaming,
    onProgress?: (p: GenerateProgress) => void,
  ): Promise<Anthropic.Message> {
    // Stream when a large output risks the SDK HTTP timeout OR when the caller wants a
    // live progress heartbeat (fix D) — the default budget generation is below the size
    // threshold, so onProgress is what forces streaming for the progress UI.
    if (onProgress || params.max_tokens >= STREAMING_THRESHOLD) {
      const stream = this.client.messages.stream(params);
      if (onProgress) {
        // As the forced-tool input JSON streams, count its size (a coarse output proxy,
        // not billed tokens) AND surface each completed design item (service/decision/
        // edge) so the UI can show the design building — not just a number climbing.
        let chars = 0;
        const scanner = new StreamItemScanner();
        stream.on("streamEvent", (event) => {
          if (event.type !== "content_block_delta") return;
          const delta = event.delta;
          const piece =
            delta.type === "input_json_delta" ? delta.partial_json : delta.type === "text_delta" ? delta.text : "";
          if (piece) {
            chars += piece.length;
            onProgress({ outputChars: chars, items: scanner.push(piece) });
          }
        });
      }
      // Streamed messages return the same final Message (tool_use blocks included);
      // extractStructuredOutput reads the forced tool call's `input`.
      return stream.finalMessage();
    }
    // Forced tool use returns a tool_use block whose `input` is guaranteed valid
    // JSON; create() returns the raw Message for extractStructuredOutput to read.
    // Do NOT use messages.parse(): it auto-parses free text and throws when the
    // (un-enforced) response is fenced/prose — which 502'd the pipeline.
    return this.client.messages.create(params);
  }

  /**
   * Run a PLAIN-TEXT (non-structured) call and return the concatenated text plus
   * usage. Unlike {@link structuredCall} there is no schema to validate against
   * and so no retry loop — HCL is free-form by nature. API/transport errors are
   * mapped to the typed ProviderError chain; a model refusal is non-retryable.
   */
  private async textCall(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<ProviderResult<string>> {
    let message: Anthropic.Message;
    try {
      // Large outputs stream to dodge the SDK HTTP timeout; the bounded config
      // default stays well under the threshold and uses the simple create path.
      message =
        params.max_tokens >= STREAMING_THRESHOLD
          ? await this.client.messages.stream(params).finalMessage()
          : await this.client.messages.create(params);
    } catch (err) {
      throw mapError(err);
    }

    if (message.stop_reason === "refusal") {
      throw new ProviderError("Model refused the request", false, message.stop_reason);
    }

    return { result: extractText(message), usage: mapUsage(message.usage) };
  }
}

/**
 * Serialize just the fields the model needs to write the config: the tier name +
 * summary, each node's service/role/security controls, and the labeled edges
 * (so any queue's DLQ and the data flow are reflected). Kept compact and stable.
 */
function buildConfigInput(tier: GeneratedTier): string {
  const payload = {
    name: tier.name,
    summary: tier.summary,
    nodes: tier.nodes.map((n) => ({
      awsService: n.awsService,
      role: n.role,
      security: n.security,
    })),
    edges: tier.edges.map((e) => ({
      from: e.from,
      to: e.to,
      payload: e.payload,
      protocol: e.protocol,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Concatenate the text blocks of a plain (non-structured) message. We defensively
 * strip a stray ```hcl ... ``` fence in case the model wraps the output despite
 * the system instruction, so callers always get raw HCL.
 */
function extractText(message: Anthropic.Message): string {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const fenced = /^```(?:hcl|terraform)?\s*\n([\s\S]*?)\n```$/.exec(text);
  return fenced?.[1]?.trim() ?? text;
}

function buildClarifyInput(description: string, priorAnswers?: string[]): string {
  if (!priorAnswers || priorAnswers.length === 0) return description;
  const answers = priorAnswers.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return `${description}\n\nPrior answers:\n${answers}`;
}

/**
 * Pull the structured object out of a forced-tool-use response: the model's
 * answer is the `input` of the tool_use block (the API guarantees it is valid
 * JSON conforming to the tool's input_schema). zod re-validates afterward in
 * {@link ClaudeProvider.structuredCall} regardless.
 */
function extractStructuredOutput(message: Anthropic.Message): unknown {
  for (const block of message.content) {
    if (block.type === "tool_use") return (block as Anthropic.ToolUseBlock).input;
  }
  throw new Error("model did not emit the required structured tool call");
}

/**
 * Repair a common forced-tool-use malformation from weaker models: a nested array
 * or object emitted as a JSON-encoded STRING (e.g. `"tiers": "[{...}]"`). Recursively
 * walk the value; any string that parses to an array/object is replaced with the
 * parsed value (and re-repaired). Non-JSON strings and scalars are left untouched, so
 * this only ever turns invalid-shape into maybe-valid — it never corrupts good output.
 */
function repairStructured(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object") return repairStructured(parsed);
      } catch {
        // not JSON — leave the string as-is
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(repairStructured);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repairStructured(v)]));
  }
  return value;
}

/** Map the SDK usage onto the ledger-facing Usage shape (KTD7/KTD11). */
function mapUsage(usage: Anthropic.Usage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** True for SDK API/transport errors (and already-mapped ProviderErrors) — never retried. */
function isApiFailure(err: unknown): boolean {
  return (
    err instanceof ProviderError ||
    err instanceof RateLimitError ||
    err instanceof APIConnectionError ||
    err instanceof APIError
  );
}

/**
 * Translate SDK errors into the typed ProviderError chain (claude-api skill):
 * rate limits and connection failures are retryable; 4xx (validation/auth) are
 * not; 5xx are. The original error is preserved as `cause`.
 */
function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof RateLimitError) {
    return new ProviderError("Anthropic rate limit exceeded", true, err);
  }
  if (err instanceof APIConnectionError) {
    return new ProviderError("Anthropic connection error", true, err);
  }
  if (err instanceof APIError) {
    const status = err.status;
    const retryable = typeof status === "number" && status >= 500;
    const label = typeof status === "number" ? ` (${status})` : "";
    return new ProviderError(`Anthropic API error${label}: ${err.message}`, retryable, err);
  }
  return new ProviderError(`Unexpected provider error: ${describe(err)}`, false, err);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
