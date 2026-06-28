/**
 * Re-run the deterministic cost step on already-seeded curated designs — refresh
 * stored $ figures after a cost-model change WITHOUT re-paying for LLM generation.
 * The design graph (model output) is untouched; only costDrivers + the disclaimer
 * are rewritten. Votes are preserved (only the body column is updated).
 *
 * The stored body carries no raw intake answer, so the per-design traffic-volume
 * multiplier is keyed by id here, mirroring seedCurated's DEMOS answers.
 *
 * Run (set DB_PATH to the gallery DB if not running from the repo root):
 *   pnpm --filter @drafture/api exec tsx scripts/recomputeCuratedCosts.ts
 */
import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { estimateCosts } from "../src/pipeline/cost.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

// parseTrafficVolume multiplier per design, matching seedCurated's intake answers.
const VOLUME_SCALE: Record<string, number> = {
  "photo-sharing-app": 1, // Hundreds–thousands a day
  "url-shortener": 30, // Millions a day
  "realtime-chat-backend": 1, // Hundreds–thousands a day
  "e-commerce-checkout-api": 1, // Hundreds–thousands a day
};

function main(): void {
  const config = getConfig();
  const ctx = buildAppContext(config);
  const region = config.DEFAULT_REGION;

  for (const summary of ctx.stores.curated.list()) {
    const run = ctx.stores.curated.get(summary.id);
    if (!run) continue;
    const design = JSON.parse(run.body) as ArchitectureResult;
    const volume = VOLUME_SCALE[summary.id] ?? 1;
    const reestimated = estimateCosts(design, ctx.stores.pricing, region, volume);
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
