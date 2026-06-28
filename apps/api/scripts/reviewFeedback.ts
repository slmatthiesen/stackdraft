/**
 * Review thumbs-up/down feedback (operator, offline).
 *
 * Prints the most-recently-updated DOWN-voted designs — the prompt, the recommended
 * tier, the intake answers, and a short summary of the snapshotted body — so an operator
 * can spot patterns and iterate the prompt/KB ("make it better"). Pass --up to list
 * up-votes instead, and an optional numeric arg to change the limit (default 20).
 *
 * Reads the feedback table directly via the store — no model call, no spend.
 *
 * Run:  pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx scripts/reviewFeedback.ts [--up] [N]
 */
import { getConfig } from "../src/config.js";
import { getDb, createStores } from "../src/store/sqlite.js";

function main(): void {
  const args = process.argv.slice(2);
  const wantUp = args.includes("--up");
  const numeric = args.find((a) => /^\d+$/.test(a));
  const limit = numeric ? Number(numeric) : 20;
  const rating: 1 | -1 = wantUp ? 1 : -1;

  const config = getConfig();
  const db = getDb(config.DB_PATH);
  const stores = createStores(db);

  const entries = stores.feedback.listByRating(rating, limit);
  const label = rating === 1 ? "UP-voted" : "DOWN-voted";
  console.log(`${entries.length} ${label} design${entries.length === 1 ? "" : "s"} (most recent first):\n`);

  for (const e of entries) {
    const preview = e.description.length > 140 ? `${e.description.slice(0, 140)}…` : e.description;
    console.log(`— [${e.recommendedTier}] "${preview}"`);
    if (e.answers.length > 0) console.log(`  answers: ${e.answers.join(" | ")}`);
    console.log(`  round ${e.round} · ${new Date(e.updatedAt).toISOString()} · hash ${e.promptHash.slice(0, 10)}`);
    if (e.body) {
      try {
        const parsed = JSON.parse(e.body) as { tiers?: { name: string; summary?: string }[] };
        const tiers = (parsed.tiers ?? [])
          .map((t) => `${t.name}${t.summary ? ` (${t.summary.slice(0, 60)})` : ""}`)
          .join("  |  ");
        if (tiers) console.log(`  tiers: ${tiers}`);
      } catch {
        /* malformed snapshot — skip the body summary */
      }
    }
    console.log();
  }

  db.close();
}

void main();
