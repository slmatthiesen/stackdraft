/**
 * Corpus growth (learning-network) — batch-generate golden prompts on the real
 * pipeline, gate them, and persist the PASSERS as `pending` for operator approval.
 *
 * Design-only (no Terraform), so it's cheap (~$0.07/prompt on Sonnet). A candidate
 * is persisted ONLY if it passes the full property gate (it would be served verbatim
 * once approved, so a gate failure must never enter the queue). Approve passers with
 * reviewGenerations.ts, then backfillEmbeddings.ts to make them retrievable.
 *
 * Bypasses the spend ledger/ceiling (offline) — mind the model. Provider follows env.
 *
 * Run:
 *   pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx \
 *     scripts/growCorpus.ts --ids sl-saas-rest,ct-ecommerce-api,...
 *   # or: --first 5   (first N of the golden set)
 */
import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { generateArchitecture } from "../src/pipeline/generate.js";
import { estimateCosts, trafficVolumeScale } from "../src/pipeline/cost.js";
import { tagDesign } from "../src/pipeline/tags.js";
import { hashPrompt } from "../src/store/responseCache.js";
import { llmCostUsd } from "../src/guards/spend.js";
import { GOLDEN_PROMPTS } from "../test/golden/prompts.js";
import { runAllProperties } from "../test/golden/properties.js";

function selectPrompts(): { id: string; description: string }[] {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const idsArg = get("--ids");
  const firstArg = get("--first");
  if (idsArg) {
    const want = new Set(idsArg.split(","));
    const picked = GOLDEN_PROMPTS.filter((p) => want.has(p.id));
    const missing = [...want].filter((id) => !picked.some((p) => p.id === id));
    if (missing.length) {
      console.error(`unknown golden id(s): ${missing.join(", ")}`);
      process.exit(1);
    }
    return picked;
  }
  if (firstArg) return GOLDEN_PROMPTS.slice(0, Number(firstArg));
  console.error("usage: growCorpus.ts --ids <a,b,c> | --first <N>");
  process.exit(1);
}

async function main(): Promise<void> {
  const prompts = selectPrompts();
  const config = getConfig();
  const ctx = buildAppContext(config);

  console.log(`Corpus growth · ${config.LLM_MODEL} · ${prompts.length} prompt(s)\n`);
  const persisted: string[] = [];
  let totalCost = 0;

  for (const p of prompts) {
    const { result, usage } = await generateArchitecture({
      provider: ctx.provider,
      memory: ctx.stores.memory,
      description: p.description,
      opts: { maxTokens: config.LLM_MAX_TOKENS, effort: config.LLM_EFFORT },
    });
    const estimated = estimateCosts(result, ctx.stores.pricing, config.DEFAULT_REGION, trafficVolumeScale([]));
    const gate = runAllProperties(estimated);
    const cost = llmCostUsd(usage, ctx.pricing);
    totalCost += cost;

    const fails = gate.results.filter((r) => !r.ok);
    if (!gate.ok) {
      console.log(`✗ ${p.id}  GATE FAIL (${gate.results.length - fails.length}/${gate.results.length}) — NOT persisted  ($${cost.toFixed(3)})`);
      for (const f of fails) console.log(`     ${f.name}: ${f.reason}`);
      continue;
    }

    const promptHash = hashPrompt({
      description: p.description,
      answers: [],
      round: 0,
      model: config.LLM_MODEL,
      region: config.DEFAULT_REGION,
    });
    const { id, status } = ctx.stores.generations.upsert({
      promptHash,
      description: p.description,
      answers: [],
      model: config.LLM_MODEL,
      region: config.DEFAULT_REGION,
      recommendedTier: estimated.recommendedTier,
      tags: tagDesign(estimated),
      body: JSON.stringify(estimated),
      clientIp: "corpus-script",
    });
    persisted.push(id);
    console.log(`✓ ${p.id}  PASS 13/13 → ${id} (${status})  tags: ${tagDesign(estimated).join(", ")}  ($${cost.toFixed(3)})`);
  }

  console.log(`\n${persisted.length}/${prompts.length} persisted as pending · ~$${totalCost.toFixed(2)} spent`);
  if (persisted.length) {
    console.log(`\nReview/approve:`);
    console.log(`  reviewGenerations.ts                 # see the pending queue`);
    for (const id of persisted) console.log(`  reviewGenerations.ts approve ${id}`);
    console.log(`Then: backfillEmbeddings.ts            # make approved designs retrievable`);
  }
}

void main();
