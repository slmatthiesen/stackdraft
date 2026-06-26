import { describe, it, expect, beforeEach } from "vitest";

import securityBaselines from "@stackdraft/kb/security-baselines.json" with { type: "json" };
import type { SecurityBaseline } from "@stackdraft/kb";

import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { seedKnowledgeBase } from "../store/kbLoader.js";

import { assembleGrounding } from "./ground.js";

const baselines = securityBaselines as SecurityBaseline[];

// A description that fires two reference patterns (serverless-api, queue-based-async)
// and two domain topics (file-uploads, async-processing). The unique markers let us
// prove the breakpoint boundary: load-bearing per-request text must NOT leak into the
// cacheable static prefix (KTD11).
const DESCRIPTION =
  "Build a serverless REST API for a photo upload app; uploaded images are processed " +
  "asynchronously through a queue. marker-Z9Q7";
const ANSWERS = ["expect bursty traffic answer-K3X", "images contain user PII answer-V8M"];

describe("assembleGrounding — static prefix (cacheable, KTD11)", () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores);
  });

  it("carries the safe-by-default mandate and ALL eight security baselines", () => {
    const { prompt } = assembleGrounding({ description: DESCRIPTION, memory: stores.memory });

    expect(baselines).toHaveLength(8);
    for (const b of baselines) {
      expect(prompt.staticPrefix).toContain(b.rule);
    }
    expect(prompt.staticPrefix.toLowerCase()).toContain("safe-by-default");
    // Budget tier framed as the minimum *safe* cost, never security-relaxed (KTD9).
    expect(prompt.staticPrefix.toLowerCase()).toContain("minimum safe cost");
  });

  it("instructs burst handling, the NAT/egress callout, and payload-labeled edges", () => {
    const { prompt } = assembleGrounding({ description: DESCRIPTION, memory: stores.memory });

    expect(prompt.staticPrefix).toContain("trivial-in-core");
    expect(prompt.staticPrefix).toContain("DynamoDB on-demand");
    expect(prompt.staticPrefix.toLowerCase()).toContain("nat");
    expect(prompt.staticPrefix.toLowerCase()).toContain("egress");
    expect(prompt.staticPrefix.toLowerCase()).toContain("payload");
  });

  it("is byte-identical across requests (so the cache prefix actually hits)", () => {
    const a = assembleGrounding({ description: "totally different system one", memory: stores.memory });
    const b = assembleGrounding({ description: "an unrelated request two", answers: ["x"], memory: stores.memory });
    expect(a.prompt.staticPrefix).toBe(b.prompt.staticPrefix);
  });
});

describe("assembleGrounding — volatile suffix (after the breakpoint, KTD11)", () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores);
  });

  it("keeps the user description and answers OUT of the cacheable prefix", () => {
    const { prompt } = assembleGrounding({
      description: DESCRIPTION,
      answers: ANSWERS,
      memory: stores.memory,
    });

    // Per-request content must never appear in the prefix — it would change the cache
    // key every request, wasting the write premium and never hitting (KTD11).
    expect(prompt.staticPrefix).not.toContain("marker-Z9Q7");
    expect(prompt.staticPrefix).not.toContain("answer-K3X");
    expect(prompt.staticPrefix).not.toContain("answer-V8M");

    expect(prompt.volatileSuffix).toContain("marker-Z9Q7");
    expect(prompt.volatileSuffix).toContain("answer-K3X");
    expect(prompt.volatileSuffix).toContain("answer-V8M");
  });

  it("places matched reference patterns in the volatile suffix only", () => {
    const { prompt, matchedPatterns } = assembleGrounding({
      description: DESCRIPTION,
      memory: stores.memory,
    });

    expect(matchedPatterns).toContain("serverless-api");
    expect(matchedPatterns).toContain("queue-based-async");
    expect(prompt.volatileSuffix).toContain("Serverless API");
    // Patterns vary per request — they are volatile, never in the cacheable prefix.
    expect(prompt.staticPrefix).not.toContain("Serverless API");
  });

  it("reports detected topics with no memory hit as missingTopics (for U6 research-on-miss)", () => {
    const { missingTopics, memoryHits } = assembleGrounding({
      description: DESCRIPTION,
      memory: stores.memory,
    });

    expect(missingTopics).toContain("file-uploads");
    expect(missingTopics).toContain("async-processing");
    expect(memoryHits).toEqual([]);
  });

  it("surfaces memory hits in the suffix and flags quarantined facts UNVERIFIED (KTD4/R9)", () => {
    stores.memory.upsert({
      id: "research:file-uploads-1",
      topic: "file-uploads",
      fact: "Use presigned S3 PUT URLs FACTMARK-trusted",
      rationale: "keeps large uploads off the API tier",
      source: "https://example.com/uploads",
      verified: true,
      provenance: "research",
    });
    stores.memory.upsert({
      id: "research:async-processing-1",
      topic: "async-processing",
      fact: "Attach an SQS dead-letter queue FACTMARK-quarantined",
      rationale: "isolates poison messages",
      source: "https://example.com/sqs",
      verified: false,
      provenance: "research",
    });

    const { prompt, memoryHits, missingTopics } = assembleGrounding({
      description: DESCRIPTION,
      memory: stores.memory,
    });

    expect(memoryHits).toEqual(
      expect.arrayContaining(["research:file-uploads-1", "research:async-processing-1"]),
    );
    expect(missingTopics).not.toContain("file-uploads");
    expect(missingTopics).not.toContain("async-processing");

    expect(prompt.volatileSuffix).toContain("FACTMARK-trusted");
    expect(prompt.volatileSuffix).toContain("FACTMARK-quarantined");

    const lines = prompt.volatileSuffix.split("\n");
    const trustedLine = lines.find((l) => l.includes("FACTMARK-trusted"));
    const quarantinedLine = lines.find((l) => l.includes("FACTMARK-quarantined"));
    // The quarantined (verified:false) fact is marked UNVERIFIED; the trusted one is not.
    expect(quarantinedLine).toMatch(/UNVERIFIED/);
    expect(trustedLine).not.toMatch(/UNVERIFIED/);
  });
});
