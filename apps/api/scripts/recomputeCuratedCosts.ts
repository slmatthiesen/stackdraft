/**
 * Re-run the deterministic cost step on already-seeded curated designs — refresh
 * stored $ figures after a cost-model change WITHOUT re-paying for LLM generation.
 * The design graph (model output) is untouched; only costDrivers + the disclaimer
 * are rewritten. Votes are preserved (only the body column is updated).
 *
 * Volume is now intrinsic to each tier ({@link TIER_VOLUME_SCALE}), so there is no
 * per-design traffic multiplier to thread through — estimateCosts costs each tier at
 * its own stage (~1k → ~10k → ~100k requests/day).
 *
 * Run (set DB_PATH to the gallery DB if not running from the repo root):
 *   pnpm --filter @drafture/api exec tsx scripts/recomputeCuratedCosts.ts
 */
import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { estimateCosts } from "../src/pipeline/cost.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

function main(): void {
  const config = getConfig();
  const ctx = buildAppContext(config);
  const region = config.DEFAULT_REGION;

  for (const summary of ctx.stores.curated.list()) {
    const run = ctx.stores.curated.get(summary.id);
    if (!run) continue;
    const design = JSON.parse(run.body) as ArchitectureResult;
    const reestimated = estimateCosts(design, ctx.stores.pricing, region);
    // upsert preserves votes + created_at (ON CONFLICT updates only body/title/prompt).
    ctx.stores.curated.upsert({
      id: summary.id,
      title: run.title,
      prompt: run.prompt,
      body: JSON.stringify(reestimated),
    });
    const rec = reestimated.tiers.find((t) => t.name === reestimated.recommendedTier);
    console.log(`  • ${summary.id}: recomputed (rec tier ${rec?.name}, ${rec?.costDrivers.length ?? 0} drivers)`);
  }

  ctx.db?.close();
  console.log("Done.");
}

void main();
