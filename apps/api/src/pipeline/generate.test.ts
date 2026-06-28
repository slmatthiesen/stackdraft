import { describe, it, expect, beforeEach } from "vitest";

import type { LlmProvider, ProviderResult, GroundedPrompt, GenerateOptions, Usage } from "../llm/provider.js";
import type { GeneratedArchitecture, Clarification, TierName } from "../schema/architecture.js";
import { ArchitectureResultSchema, TIER_NAMES } from "../schema/architecture.js";

import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { seedKnowledgeBase } from "../store/kbLoader.js";

import { generateArchitecture } from "./generate.js";
import { estimateCosts } from "./cost.js";
import { securityFloorLines } from "./securityFloor.js";

const USAGE: Usage = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 4096, cacheWriteTokens: 0 };

// --- Canned schema-valid result ---------------------------------------------

function makeTier(name: TierName): GeneratedArchitecture["tiers"][number] {
  return {
    name,
    summary: `${name} tier`,
    nodes: [
      {
        id: "api",
        awsService: "API Gateway",
        role: "front door",
        security: ["TLS", "WAF", "throttling", "least-priv role"],
      },
      {
        id: "db",
        awsService: "DynamoDB",
        role: "primary datastore",
        security: ["encryption at rest", "on-demand", "least-priv role"],
      },
    ],
    edges: [
      { from: "client", to: "api", payload: "JSON request body", protocol: "HTTPS" },
      { from: "api", to: "db", payload: "item read/write", protocol: "HTTPS" },
    ],
    delta:
      name === "budget"
        ? ["baseline: single-AZ, DynamoDB on-demand absorbs bursts"]
        : ["+ multi-AZ", "+ optional SQS buffering for write bursts"],
    tradeoffs: ["vs balanced: cheaper, single-AZ"],
  };
}

// The provider returns the GENERATED shape — no securityFloor (injected by the
// pipeline from the KB). See securityFloor.ts.
function validArchitecture(): GeneratedArchitecture {
  return {
    assumptions: ["single region us-east-1"],
    clarificationsUsed: [],
    tiers: TIER_NAMES.map(makeTier),
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

// --- In-test provider (no network) ------------------------------------------

interface FakeProvider {
  provider: LlmProvider;
  calls: { prompts: GroundedPrompt[]; opts: (GenerateOptions | undefined)[] };
}

function fakeProvider(arch: GeneratedArchitecture): FakeProvider {
  const calls: FakeProvider["calls"] = { prompts: [], opts: [] };
  const provider: LlmProvider = {
    async generate(prompt, opts): Promise<ProviderResult<GeneratedArchitecture>> {
      calls.prompts.push(prompt);
      calls.opts.push(opts);
      return { result: arch, usage: USAGE };
    },
    async clarify(): Promise<ProviderResult<Clarification>> {
      return { result: { needsClarification: false, questions: [] }, usage: USAGE };
    },
    async generateConfig(): Promise<ProviderResult<string>> {
      return { result: 'resource "aws_lambda_function" "api" {}', usage: USAGE };
    },
    async countTokens(text: string): Promise<number> {
      return text.length;
    },
  };
  return { provider, calls };
}

const FULLY_SPECIFIED =
  "A serverless REST API on Lambda + DynamoDB for a small SaaS; bursty but low volume.";

describe("generateArchitecture", () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores);
  });

  it("returns three schema-valid tiers in one pass (happy, R3)", async () => {
    const { provider, calls } = fakeProvider(validArchitecture());

    const { result, usage } = await generateArchitecture({
      provider,
      memory: stores.memory,
      description: FULLY_SPECIFIED,
    });

    // generateArchitecture returns the GENERATED shape (no costDrivers); estimateCosts
    // fills them like the route/seed do, so parse the FULL result after the cost step.
    const estimated = estimateCosts(result, stores.pricing, "us-east-1");
    expect(() => ArchitectureResultSchema.parse(estimated)).not.toThrow();
    expect(result.tiers.map((t) => t.name)).toEqual(["budget", "balanced", "resilient"]);
    expect(usage).toEqual(USAGE);
    expect(calls.prompts).toHaveLength(1);
  });

  it("injects the deterministic security floor from the KB, not the model (edge, R7)", async () => {
    const { provider, calls } = fakeProvider(validArchitecture());

    const { result } = await generateArchitecture({
      provider,
      memory: stores.memory,
      description: FULLY_SPECIFIED,
    });

    // DETERMINISTIC: the floor is injected from the KB, identical every request,
    // not generated (and re-paid for) by the model.
    expect(result.securityFloor).toEqual(securityFloorLines());
    expect(result.securityFloor.length).toBeGreaterThan(0);
    expect(result.securityFloor.every((n) => n.trim().length > 0)).toBe(true);
    // The system prompt tells the model NOT to emit the floor (it's injected).
    const prefix = calls.prompts[0]?.staticPrefix ?? "";
    expect(prefix.toLowerCase()).toContain("safe-by-default");
    expect(prefix.toLowerCase()).toContain("injected");
  });

  it("drives burst mechanisms for a high-throughput description (edge, R8)", async () => {
    const { provider, calls } = fakeProvider(validArchitecture());

    const { result } = await generateArchitecture({
      provider,
      memory: stores.memory,
      description: "A public API handling high throughput — millions of requests with heavy write bursts.",
    });

    // System prompt carries the burst instruction (trivial-in-core vs option).
    const prefix = calls.prompts[0]?.staticPrefix ?? "";
    expect(prefix).toContain("trivial-in-core");
    expect(prefix).toContain("DynamoDB on-demand");

    // LEANER SHAPE: burst handling is expressed via the tier delta + node tags.
    for (const tier of result.tiers) {
      expect(tier.delta.length).toBeGreaterThan(0);
    }
  });

  it("labels every edge with a payload (edge, R4)", async () => {
    const { provider } = fakeProvider(validArchitecture());

    const { result } = await generateArchitecture({
      provider,
      memory: stores.memory,
      description: FULLY_SPECIFIED,
    });

    for (const tier of result.tiers) {
      expect(tier.edges.length).toBeGreaterThan(0);
      for (const edge of tier.edges) {
        expect(edge.payload.trim().length).toBeGreaterThan(0);
        expect(edge.protocol.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("includes memory hits in the grounding telemetry when present for the domain (integration, R9)", async () => {
    stores.memory.upsert({
      id: "research:file-uploads-1",
      topic: "file-uploads",
      fact: "Use presigned S3 PUT URLs",
      rationale: "keeps large uploads off the API tier",
      source: "https://example.com/uploads",
      verified: true,
      provenance: "research",
    });
    const { provider, calls } = fakeProvider(validArchitecture());

    const { grounding } = await generateArchitecture({
      provider,
      memory: stores.memory,
      description: "An app where users upload photos and images for processing.",
    });

    expect(grounding.memoryHits).toContain("research:file-uploads-1");
    expect(grounding.matchedPatterns.length).toBeGreaterThan(0);
    // The hit landed in the volatile suffix the provider actually received.
    expect(calls.prompts[0]?.volatileSuffix).toContain("presigned S3 PUT URLs");
  });

  it("passes generate options through to the provider", async () => {
    const { provider, calls } = fakeProvider(validArchitecture());
    const opts: GenerateOptions = { maxTokens: 4321, effort: "high" };

    await generateArchitecture({
      provider,
      memory: stores.memory,
      description: FULLY_SPECIFIED,
      opts,
    });

    expect(calls.opts[0]).toEqual(opts);
  });
});
