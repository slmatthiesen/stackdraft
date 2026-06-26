/**
 * Generation step (U5) — the one-pass tiered architecture build.
 *
 * Assembles the grounded prompt (ground.ts, split at the cache breakpoint) and
 * hands it to the provider, which returns all three tiers in a single call. The
 * grounding telemetry (matched patterns, memory hits, missing topics) rides along
 * so the caller can log it and U6 can research the misses.
 */
import type { GenerateOptions, LlmProvider, Usage } from "../llm/provider.js";
import type { ArchitectureResult } from "../schema/architecture.js";
import type { MemoryStore } from "../store/types.js";

import { assembleGrounding } from "./ground.js";
import { securityFloorLines } from "./securityFloor.js";

export interface GenerateInput {
  provider: LlmProvider;
  memory: MemoryStore;
  description: string;
  answers?: string[];
  /** Cost ceiling for the call; defaults are applied by the provider (config). */
  opts?: GenerateOptions;
}

export interface GroundingTelemetry {
  matchedPatterns: string[];
  memoryHits: string[];
  missingTopics: string[];
}

export interface GenerateOutput {
  result: ArchitectureResult;
  usage: Usage;
  grounding: GroundingTelemetry;
}

export async function generateArchitecture(input: GenerateInput): Promise<GenerateOutput> {
  const { prompt, matchedPatterns, memoryHits, missingTopics } = assembleGrounding({
    description: input.description,
    answers: input.answers,
    memory: input.memory,
  });

  const { result: generated, usage } = await input.provider.generate(prompt, input.opts);

  // Inject the deterministic security floor from the KB — the model never emits it.
  const result: ArchitectureResult = { ...generated, securityFloor: securityFloorLines() };

  return {
    result,
    usage,
    grounding: { matchedPatterns, memoryHits, missingTopics },
  };
}
