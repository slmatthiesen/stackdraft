/**
 * Generation step (U5) — the one-pass tiered architecture build.
 *
 * Assembles the grounded prompt (ground.ts, split at the cache breakpoint) and
 * hands it to the provider, which returns all three tiers in a single call. The
 * grounding telemetry (matched patterns, memory hits, missing topics) rides along
 * so the caller can log it and U6 can research the misses.
 */
import type { GenerateOptions, LlmProvider, Usage } from "../llm/provider.js";
import type { ArchitectureBeforeCost } from "../schema/architecture.js";
import type { MemoryStore } from "../store/types.js";

import { assembleGrounding } from "./ground.js";
import { sanitizeGenerated } from "./sanitize.js";
import { securityFloorLines } from "./securityFloor.js";

export interface GenerateInput {
  provider: LlmProvider;
  memory: MemoryStore;
  description: string;
  answers?: string[];
  /** Cost ceiling for the call; defaults are applied by the provider (config). */
  opts?: GenerateOptions;
  /** Optional "similar designs we've shipped" block from the learning network (retrieve.ts). */
  exemplarsSection?: string;
}

export interface GroundingTelemetry {
  matchedPatterns: string[];
  memoryHits: string[];
  missingTopics: string[];
}

export interface GenerateOutput {
  result: ArchitectureBeforeCost;
  usage: Usage;
  grounding: GroundingTelemetry;
}

export async function generateArchitecture(input: GenerateInput): Promise<GenerateOutput> {
  const { prompt, matchedPatterns, memoryHits, missingTopics } = assembleGrounding({
    description: input.description,
    answers: input.answers,
    memory: input.memory,
    exemplarsSection: input.exemplarsSection,
  });

  const { result: generated, usage } = await input.provider.generate(prompt, input.opts);

  // Deterministically fix the model's most common tag error (a "private subnet"
  // tag on a managed/serverless service) before injecting the security floor.
  const cleaned = sanitizeGenerated(generated);

  // Inject the deterministic security floor from the KB — the model never emits it.
  // costDrivers are filled later by estimateCosts, so this is ArchitectureBeforeCost.
  //
  // The model no longer picks a recommended tier: the three tiers are a scale ladder
  // (low→high), so we always pre-select BALANCED — the medium-business default — and
  // let the user click up/down. recommendationRationale is intentionally empty (no
  // recommendation prose); the field is kept only for response-shape stability.
  const result: ArchitectureBeforeCost = {
    ...cleaned,
    securityFloor: securityFloorLines(),
    recommendedTier: "balanced",
    recommendationRationale: "",
  };

  return {
    result,
    usage,
    grounding: { matchedPatterns, memoryHits, missingTopics },
  };
}
