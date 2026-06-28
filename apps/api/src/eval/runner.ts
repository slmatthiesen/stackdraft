/**
 * Golden-set eval runner (U15/R16).
 *
 * Drives each golden prompt through the real generation pipeline
 * ({@link generateArchitecture}) and runs the universal property checkers on each
 * result, producing a PASS-RATE. The pass-rate is the TRACKED metric — we do NOT
 * assert it at a fixed value in tests (an LLM's output varies run to run); instead
 * it gates model/KB changes by flagging a drop relative to a configurable floor.
 *
 * In tests the provider is a FAKE returning a canned schema-valid result, so the
 * runner exercises end-to-end with zero network/paid calls. `main()` (guarded so
 * it only runs when invoked directly) builds a real ClaudeProvider for an on-demand
 * eval and exits non-zero below the floor so CI/operators can gate on it.
 */
import { fileURLToPath } from "node:url";

import type { LlmProvider } from "../llm/provider.js";
import type { ArchitectureResult } from "../schema/architecture.js";
import type { MemoryStore, PricingStore } from "../store/types.js";
import { generateArchitecture } from "../pipeline/generate.js";
import { estimateCosts } from "../pipeline/cost.js";

import { GOLDEN_PROMPTS, type GoldenPrompt } from "../../test/golden/prompts.js";
import {
  runAllProperties,
  type AggregateResult,
  type PropertyResult,
} from "../../test/golden/properties.js";

export interface PerPromptResult {
  id: string;
  ok: boolean;
  properties: PropertyResult[];
}

export interface EvalReport {
  total: number;
  passed: number;
  /** passed / total, in [0,1]; 0 when total is 0. The tracked metric. */
  passRate: number;
  perPrompt: PerPromptResult[];
}

export interface RunEvalInput {
  provider: LlmProvider;
  memory: MemoryStore;
  /** PricingStore so the runner can run the deterministic cost step — the model no
   *  longer emits costDrivers (schema split), so estimateCosts fills them and adds
   *  the list-price disclaimer the property gate checks. Mirrors the real pipeline. */
  pricing: PricingStore;
  /** Region for the cost estimate; defaults to us-east-1. */
  region?: string;
  /** Defaults to the full golden set. */
  prompts?: readonly GoldenPrompt[];
  /** Override the property aggregator (defaults to the full property suite). */
  properties?: (result: ArchitectureResult) => AggregateResult;
}

/** Run the golden set and compute the pass-rate. A prompt passes iff every property passes. */
export async function runEval(input: RunEvalInput): Promise<EvalReport> {
  const prompts = input.prompts ?? GOLDEN_PROMPTS;
  const check = input.properties ?? runAllProperties;

  const perPrompt: PerPromptResult[] = [];
  for (const prompt of prompts) {
    const { result } = await generateArchitecture({
      provider: input.provider,
      memory: input.memory,
      description: prompt.description,
    });
    // Run the deterministic cost step so the result mirrors what the route/seed
    // produce: the model emits no costDrivers, so estimateCosts fills them and
    // appends the on-demand list-price disclaimer the property gate checks.
    const estimated = estimateCosts(result, input.pricing, input.region ?? "us-east-1");
    const aggregate = check(estimated);
    perPrompt.push({ id: prompt.id, ok: aggregate.ok, properties: aggregate.results });
  }

  const total = perPrompt.length;
  const passed = perPrompt.filter((p) => p.ok).length;
  const passRate = total === 0 ? 0 : passed / total;

  return { total, passed, passRate, perPrompt };
}

/** Render a readable summary (used by main() and handy for logs). */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`golden eval: ${report.passed}/${report.total} prompts passed (pass-rate ${(report.passRate * 100).toFixed(1)}%)`);
  for (const p of report.perPrompt) {
    if (p.ok) continue;
    const fails = p.properties.filter((r) => !r.ok).map((r) => `${r.name}: ${r.reason}`);
    lines.push(`  FAIL ${p.id}`);
    for (const f of fails) lines.push(`    - ${f}`);
  }
  return lines.join("\n");
}

const DEFAULT_PASS_RATE_FLOOR = 0.9;

/**
 * On-demand / CI entry point. Builds a real ClaudeProvider from config and runs
 * the golden set against it (this DOES spend tokens, so it is gated behind the
 * direct-invoke check below and never runs in unit tests). Exits non-zero when
 * the pass-rate is below the floor so it can gate a model/KB change.
 *
 * Dynamic imports keep config/SDK/SQLite out of the module's import graph, so
 * importing this file in tests never touches the network or requires a real key.
 */
async function main(): Promise<void> {
  const floor = Number(process.env.EVAL_PASS_RATE_FLOOR ?? DEFAULT_PASS_RATE_FLOOR);

  let config;
  try {
    const { loadConfig } = await import("../config.js");
    config = loadConfig();
  } catch (err) {
    // Most commonly a missing ANTHROPIC_API_KEY. A real eval can't run without it,
    // but this is an expected "early exit", not a crash — keep it clean.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Skipping golden eval — configuration not ready:\n${msg}`);
    process.exitCode = 0;
    return;
  }

  const { ClaudeProvider } = await import("../llm/claude.js");
  const { getDb, createStores } = await import("../store/sqlite.js");
  const { seedKnowledgeBase } = await import("../store/kbLoader.js");

  const stores = createStores(getDb(config.DB_PATH));
  seedKnowledgeBase(stores);

  const provider = ClaudeProvider.fromConfig(config);
  const report = await runEval({
    provider,
    memory: stores.memory,
    pricing: stores.pricing,
    region: config.DEFAULT_REGION,
  });

  console.log(formatReport(report));

  if (report.passRate < floor) {
    console.error(`pass-rate ${(report.passRate * 100).toFixed(1)}% is below floor ${(floor * 100).toFixed(1)}% — failing the gate.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
