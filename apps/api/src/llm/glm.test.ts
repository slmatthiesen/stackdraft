import { describe, it, expect, vi } from "vitest";

import { GlmProvider } from "./glm.js";
import { ProviderError } from "./provider.js";
import type { GroundedPrompt } from "./provider.js";
import { GeneratedArchitectureSchema } from "../schema/architecture.js";
import type { GeneratedArchitecture, GeneratedWire, Clarification, TierName } from "../schema/architecture.js";

// --- Test doubles -----------------------------------------------------------

/** A minimal Response-shape object the provider reads (.ok/.status/.json/.statusText). */
interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function okResponse(body: unknown): MockResponse {
  return { ok: true, status: 200, statusText: "OK", json: async () => body };
}

function errorResponse(status: number, message: string): MockResponse {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({ error: { message } }),
  };
}

/** GLM OpenAI-compatible response with a forced function call carrying `arguments`. */
function glmToolResponse(
  input: unknown,
  usage: { prompt_tokens?: number; completion_tokens?: number } = {},
  name = "emit_architecture",
): unknown {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(input) } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: usage.prompt_tokens ?? 100, completion_tokens: usage.completion_tokens ?? 50 },
  };
}

function makeProvider(fetchMock: ReturnType<typeof vi.fn>): GlmProvider {
  return new GlmProvider(
    { apiKey: "glm-key", baseUrl: "https://glm.example/api/paas/v4", model: "glm-4.6", maxTokens: 8000 },
    fetchMock as unknown as typeof fetch,
  );
}

const PROMPT: GroundedPrompt = {
  staticPrefix: "SYSTEM PROMPT + FULL SECURITY BASELINES",
  volatileSuffix: "matched patterns + memory + user description",
};

// --- Fixtures ---------------------------------------------------------------

function makeTier(name: TierName): GeneratedArchitecture["tiers"][number] {
  return {
    name,
    summary: `${name} tier`,
    nodes: [{ id: "api", awsService: "API Gateway", role: "front door", security: ["TLS", "WAF"] }],
    edges: [{ from: "client", to: "api", payload: "request", protocol: "HTTPS" }],
    delta: ["baseline: single-AZ"],
    tradeoffs: ["Cheaper than resilient"],
  };
}

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

// The model emits the tier-delta WIRE shape; these no-op deltas reconstruct EXACTLY
// to validArchitecture()'s three tiers (the provider reconstructs before returning).
function validWire(): GeneratedWire {
  const arch = validArchitecture();
  const delta = (name: TierName): GeneratedWire["tierDeltas"][number] => ({
    name,
    summary: `${name} tier`,
    addNodes: [],
    removeNodeIds: [],
    addEdges: [],
    removeEdges: [],
    delta: ["baseline: single-AZ"],
    tradeoffs: ["Cheaper than resilient"],
  });
  return {
    assumptions: arch.assumptions,
    clarificationsUsed: arch.clarificationsUsed,
    baseTier: makeTier("budget"),
    tierDeltas: [delta("balanced"), delta("resilient")],
    keyDecisions: arch.keyDecisions,
  };
}

// --- Tests ------------------------------------------------------------------

describe("GlmProvider.generate", () => {
  it("returns a schema-valid ArchitectureResult for a representative prompt", async () => {
    const arch = validArchitecture();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(okResponse(glmToolResponse(validWire(), { prompt_tokens: 1200, completion_tokens: 800 })));

    const { result, usage } = await makeProvider(fetchMock).generate(PROMPT);

    expect(result).toEqual(GeneratedArchitectureSchema.parse(arch));
    expect(result.tiers.map((t) => t.name)).toEqual(["budget", "balanced", "resilient"]);
    expect(usage.inputTokens).toBe(1200);
    expect(usage.outputTokens).toBe(800);
    expect(usage.cacheReadTokens).toBe(0); // GLM usage has no cache fields
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a FORCED function call with system+user messages from the grounded prompt", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(okResponse(glmToolResponse(validWire())));

    await makeProvider(fetchMock).generate(PROMPT);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://glm.example/api/paas/v4/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.tools).toEqual([
      expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "emit_architecture" }) }),
    ]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "emit_architecture" } });
    // GLM-4.5 reasoning is disabled for our structured calls (latency, no quality gain).
    expect(body.thinking).toEqual({ type: "disabled" });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: PROMPT.staticPrefix });
    expect(messages[1]).toEqual({ role: "user", content: PROMPT.volatileSuffix });
    // Bearer auth header.
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer glm-key");
  });

  it("retries exactly once on malformed function arguments, then succeeds", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(okResponse(glmToolResponse({ not: "valid" })))
      .mockResolvedValueOnce(okResponse(glmToolResponse(validWire())));

    const { result } = await makeProvider(fetchMock).generate(PROMPT);

    expect(result.tiers).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a non-retryable ProviderError after the retry also fails validation", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(okResponse(glmToolResponse({ still: "wrong" })));

    const err = await makeProvider(fetchMock).generate(PROMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps a 429 to a retryable ProviderError without retrying", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(errorResponse(429, "rate limited"));

    const err = await makeProvider(fetchMock).generate(PROMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // transport error — never retried here
  });

  it("maps a 4xx (non-429) to a non-retryable ProviderError", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(errorResponse(400, "bad model"));

    const err = await makeProvider(fetchMock).generate(PROMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("maps a network failure (fetch rejects) to a retryable ProviderError", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const err = await makeProvider(fetchMock).generate(PROMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

describe("GlmProvider.generateConfig", () => {
  const HCL = 'resource "aws_lambda_function" "api" {\n  function_name = "api"\n}';

  it("returns reference-only HCL as plain text and strips a stray markdown fence", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      okResponse({
        choices: [{ finish_reason: "stop", message: { content: "```hcl\n" + HCL + "\n```" } }],
        usage: { prompt_tokens: 420, completion_tokens: 1300 },
      }),
    );

    const { result, usage } = await makeProvider(fetchMock).generateConfig(makeTier("balanced"), { maxTokens: 1000 });

    expect(result).toBe(HCL);
    expect(usage.inputTokens).toBe(420);
    expect(usage.outputTokens).toBe(1300);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1000);
    expect(body.tools).toBeUndefined(); // plain text — no function call
  });
});

describe("GlmProvider.clarify", () => {
  it("returns the clarification verdict from the forced function call", async () => {
    const fetchMock = vi.fn();
    const payload: Clarification = { needsClarification: true, questions: ["Expected traffic?"] };
    fetchMock.mockResolvedValueOnce(okResponse(glmToolResponse(payload, {}, "emit_clarification")));

    const { result } = await makeProvider(fetchMock).clarify("something vague");

    expect(result.needsClarification).toBe(true);
    expect(result.questions).toEqual(["Expected traffic?"]);
  });
});

describe("GlmProvider.countTokens", () => {
  it("returns a cheap ~chars/4 estimate (GLM has no token-count endpoint)", async () => {
    const n = await makeProvider(vi.fn()).countTokens("a".repeat(40));
    expect(n).toBe(10);
  });
});
