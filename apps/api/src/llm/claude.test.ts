import { describe, it, expect, vi } from "vitest";
import Anthropic, {
  APIConnectionError,
  BadRequestError,
  RateLimitError,
} from "@anthropic-ai/sdk";

import { ClaudeProvider } from "./claude.js";
import { ProviderError } from "./provider.js";
import type { GroundedPrompt } from "./provider.js";
import { GeneratedArchitectureSchema } from "../schema/architecture.js";
import type { GeneratedArchitecture, Clarification, TierName } from "../schema/architecture.js";

// --- Test doubles -----------------------------------------------------------

function fakeClient() {
  const create = vi.fn();
  const countTokens = vi.fn();
  const finalMessage = vi.fn();
  const stream = vi.fn(() => ({ finalMessage }));
  const client = {
    messages: { create, countTokens, stream },
  } as unknown as Anthropic;
  return { client, create, countTokens, stream, finalMessage };
}

function makeProvider(client: Anthropic) {
  return new ClaudeProvider(client, {
    model: "claude-sonnet-4-6",
    maxTokens: 8000,
    effort: "medium",
  });
}

interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Mirrors what `messages.create()` returns for a FORCED-TOOL-USE call: the
 * structured answer is the `input` of a `tool_use` block (stop_reason "tool_use").
 */
function toolMessage(
  input: unknown,
  usage: FakeUsage = {},
  stopReason: Anthropic.Message["stop_reason"] = "tool_use",
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: stopReason,
    stop_sequence: null,
    content: [{ type: "tool_use", id: "toolu_test", name: "emit_architecture", input }],
    usage: {
      input_tokens: usage.input_tokens ?? 100,
      output_tokens: usage.output_tokens ?? 50,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  } as unknown as Anthropic.Message;
}

const PROMPT: GroundedPrompt = {
  staticPrefix: "SYSTEM PROMPT + FULL SECURITY BASELINES",
  volatileSuffix: "matched patterns + memory + user description",
};

/** Mirrors a plain (non-structured) `messages.create()` response: text blocks. */
function textMessage(text: string, usage: FakeUsage = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text }],
    usage: {
      input_tokens: usage.input_tokens ?? 100,
      output_tokens: usage.output_tokens ?? 50,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  } as unknown as Anthropic.Message;
}

// --- Fixtures ---------------------------------------------------------------

function makeTier(name: TierName): GeneratedArchitecture["tiers"][number] {
  return {
    name,
    summary: `${name} tier`,
    nodes: [
      { id: "api", awsService: "API Gateway", role: "front door", security: ["TLS", "WAF", "throttling"] },
    ],
    edges: [{ from: "client", to: "api", payload: "request", protocol: "HTTPS" }],
    delta: ["baseline: single-AZ, throttling absorbs bursts"],
    tradeoffs: ["Cheaper than resilient"],
  };
}

// The model output OMITS securityFloor (it is injected deterministically
// downstream); the provider validates against the GENERATED schema, which would
// reject an unexpected securityFloor field.
function validArchitecture(): GeneratedArchitecture {
  return {
    assumptions: ["single region"],
    clarificationsUsed: [],
    tiers: [makeTier("budget"), makeTier("balanced"), makeTier("resilient")],
    keyDecisions: [
      {
        decision: "Compute model",
        chosen: "Lambda behind API Gateway",
        alternativesConsidered: ["Fargate"],
        rationale: "Serverless scales to zero and removes capacity management.",
      },
    ],
  };
}

// --- Tests ------------------------------------------------------------------

describe("ClaudeProvider.generate", () => {
  it("returns a schema-valid ArchitectureResult for a representative prompt", async () => {
    const arch = validArchitecture();
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(toolMessage(arch, { input_tokens: 1200, output_tokens: 800 }));

    const { result, usage } = await makeProvider(client).generate(PROMPT);

    expect(result).toEqual(GeneratedArchitectureSchema.parse(arch));
    expect(result.tiers.map((t) => t.name)).toEqual(["budget", "balanced", "resilient"]);
    expect(usage.inputTokens).toBe(1200);
    expect(usage.outputTokens).toBe(800);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("places the cache breakpoint ONLY on the static prefix (KTD11)", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(toolMessage(validArchitecture()));

    await makeProvider(client).generate(PROMPT);

    const params = create.mock.calls.at(-1)?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(Array.isArray(params.system)).toBe(true);
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system[0]?.text).toBe(PROMPT.staticPrefix);
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });

    const content = params.messages[0]?.content as Anthropic.ContentBlockParam[];
    const suffixBlock = content[0] as Anthropic.TextBlockParam;
    expect(suffixBlock.text).toBe(PROMPT.volatileSuffix);
    expect(suffixBlock.cache_control ?? undefined).toBeUndefined();

    // Structured output is delivered via FORCED TOOL USE (reliable on Sonnet and
    // Haiku); output_config.format is not used (it was not enforced for our model).
    expect(params.output_config).toBeUndefined();
    expect(params.tools).toHaveLength(1);
    expect(params.tools?.[0]?.name).toBe("emit_architecture");
    expect(params.tool_choice).toEqual({ type: "tool", name: "emit_architecture" });

    // Regression: Anthropic rejects array minItems/maxItems other than 0/1 (a
    // `.length(3)` in zod 400'd live). The tool input_schema must carry no such
    // bounds — zod still enforces them when validating the tool input.
    const badBounds: string[] = [];
    const scan = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => scan(n, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      for (const k of ["minItems", "maxItems"]) {
        const v = o[k];
        if (typeof v === "number" && v !== 0 && v !== 1) badBounds.push(`${path}.${k}=${v}`);
      }
      for (const k of Object.keys(o)) scan(o[k], `${path}/${k}`);
    };
    const tool = params.tools?.[0] as { input_schema: unknown } | undefined;
    scan(tool?.input_schema, "schema");
    expect(badBounds).toEqual([]);
  });

  it("uses forced tool use on Haiku too (no output_config / effort on the wire)", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(toolMessage(validArchitecture()));

    const haiku = new ClaudeProvider(client, { model: "claude-haiku-4-5", maxTokens: 8000, effort: "low" });
    await haiku.generate(PROMPT);

    const params = create.mock.calls.at(-1)?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.output_config).toBeUndefined();
    expect(params.tools?.[0]?.name).toBe("emit_architecture");
    expect(params.tool_choice).toEqual({ type: "tool", name: "emit_architecture" });
  });

  it("propagates cache-token usage so the caller can debit the ledger", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(
      toolMessage(validArchitecture(), {
        input_tokens: 300,
        output_tokens: 900,
        cache_read_input_tokens: 4096,
        cache_creation_input_tokens: 2048,
      }),
    );

    const { usage } = await makeProvider(client).generate(PROMPT);

    expect(usage).toEqual({
      inputTokens: 300,
      outputTokens: 900,
      cacheReadTokens: 4096,
      cacheWriteTokens: 2048,
    });
  });

  it("retries exactly once on a malformed tool input, then succeeds", async () => {
    const { client, create } = fakeClient();
    create
      .mockResolvedValueOnce(toolMessage({ not: "valid" }))
      .mockResolvedValueOnce(toolMessage(validArchitecture()));

    const { result } = await makeProvider(client).generate(PROMPT);

    expect(result.tiers).toHaveLength(3);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throws a non-retryable ProviderError after the retry also fails validation", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValue(toolMessage({ still: "wrong" }));

    const err = await makeProvider(client).generate(PROMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("ClaudeProvider.generateConfig", () => {
  const HCL = 'resource "aws_lambda_function" "api" {\n  function_name = "api"\n}';

  it("returns reference-only HCL and propagates usage, as a plain-text (non-structured) call", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(textMessage(HCL, { input_tokens: 420, output_tokens: 1300 }));

    const { result, usage } = await makeProvider(client).generateConfig(makeTier("balanced"));

    expect(result).toBe(HCL);
    expect(usage.inputTokens).toBe(420);
    expect(usage.outputTokens).toBe(1300);

    const params = create.mock.calls.at(-1)?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    // cache_control stays on the static system prefix; plain text means no tool use.
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(params.output_config).toBeUndefined();
    expect(params.tools).toBeUndefined();
    expect(params.max_tokens).toBe(2500);
    const userText = (params.messages[0]?.content as Anthropic.ContentBlockParam[])[0] as Anthropic.TextBlockParam;
    expect(userText.text).toContain("balanced");
  });

  it("honors a maxTokens override and strips a stray markdown fence", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(textMessage("```hcl\n" + HCL + "\n```"));

    const { result } = await makeProvider(client).generateConfig(makeTier("budget"), { maxTokens: 1000 });

    expect(result).toBe(HCL);
    const params = create.mock.calls.at(-1)?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.max_tokens).toBe(1000);
  });

  it("maps SDK errors to a ProviderError", async () => {
    const { client, create } = fakeClient();
    create.mockRejectedValueOnce(new RateLimitError(429, undefined, "rate limited", new Headers()));

    const err = await makeProvider(client).generateConfig(makeTier("resilient")).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

describe("ClaudeProvider.clarify", () => {
  it("returns needsClarification:false for a fully-specified prompt", async () => {
    const { client, create } = fakeClient();
    const payload: Clarification = { needsClarification: false, questions: [] };
    create.mockResolvedValueOnce(toolMessage(payload));

    const { result } = await makeProvider(client).clarify("a fully specified system");

    expect(result.needsClarification).toBe(false);
    expect(result.questions).toEqual([]);
  });

  it("returns true with at most two questions for an ambiguous prompt", async () => {
    const { client, create } = fakeClient();
    const payload: Clarification = {
      needsClarification: true,
      questions: ["Expected traffic?", "Data sensitivity?"],
    };
    create.mockResolvedValueOnce(toolMessage(payload));

    const { result } = await makeProvider(client).clarify("something vague");

    expect(result.needsClarification).toBe(true);
    expect(result.questions.length).toBeLessThanOrEqual(2);
  });

  it("threads prior answers into the model input", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(toolMessage({ needsClarification: false, questions: [] }));

    await makeProvider(client).clarify("desc", ["bursty traffic", "PII present"]);

    const params = create.mock.calls.at(-1)?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    const userText = params.messages[0]?.content as string;
    expect(userText).toContain("bursty traffic");
    expect(userText).toContain("PII present");
  });
});

describe("ClaudeProvider error mapping", () => {
  it("surfaces RateLimitError as a retryable ProviderError without retrying", async () => {
    const { client, create } = fakeClient();
    const rateLimit = new RateLimitError(429, undefined, "rate limited", new Headers());
    create.mockRejectedValue(rateLimit);

    const err = await makeProvider(client).generate(PROMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).cause).toBe(rateLimit);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces APIConnectionError as a retryable ProviderError", async () => {
    const { client, create } = fakeClient();
    const conn = new APIConnectionError({ message: "socket hang up" });
    create.mockRejectedValue(conn);

    const err = await makeProvider(client).generate(PROMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).cause).toBe(conn);
  });

  it("maps a 4xx APIError to a non-retryable ProviderError", async () => {
    const { client, create } = fakeClient();
    create.mockRejectedValue(new BadRequestError(400, undefined, "bad request", new Headers()));

    const err = await makeProvider(client).clarify("x").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });
});

describe("ClaudeProvider.countTokens", () => {
  it("returns the SDK input-token count", async () => {
    const { client, countTokens } = fakeClient();
    countTokens.mockResolvedValueOnce({ input_tokens: 4321 });

    const n = await makeProvider(client).countTokens("some grounded prompt text");

    expect(n).toBe(4321);
    expect(countTokens).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-4-6" }));
  });

  it("maps SDK errors from countTokens to ProviderError", async () => {
    const { client, countTokens } = fakeClient();
    countTokens.mockRejectedValueOnce(new RateLimitError(429, undefined, "rate limited", new Headers()));

    const err = await makeProvider(client).countTokens("x").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
});
