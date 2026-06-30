/**
 * Idle-floor report (cost-honest Budget — docs/plans/2026-06-29-003).
 *
 * Prints each design's BUDGET-tier idle floor (what it bills at zero traffic) and the
 * `budgetTierIsCostHonest` verdict, so the serverless-first posture change can be
 * PROVEN: re-run before/after and watch the bloated floors drop. Reads all persisted
 * generations (any status) plus any design.json paths passed as args. Offline, $0.
 *
 * Run:
 *   pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx \
 *     scripts/costFloorReport.ts [extra-design.json ...]
 */
import { readFileSync } from "node:fs";

import { getConfig } from "../src/config.js";
import { getDb } from "../src/store/sqlite.js";
import { budgetIdleFloor } from "../src/pipeline/costFloor.js";
import { budgetTierIsCostHonest } from "../test/golden/properties.js";

const DOGFOOD = [
  "../../dogfood/happyhourfriends/design.json",
  "../../dogfood/trade-monitoring-handoff/design.json",
];

function main(): void {
  const db = getDb(getConfig().DB_PATH);
  const rows: { label: string; design: unknown }[] = [];

  const gens = db
    .prepare("SELECT id, description, status, body_json FROM generations ORDER BY created_at DESC")
    .all() as { id: string; description: string; status: string; body_json: string }[];
  for (const g of gens) {
    rows.push({ label: `${g.description.slice(0, 22)} [${g.status}]`, design: JSON.parse(g.body_json) });
  }
  for (const path of [...DOGFOOD, ...process.argv.slice(2)]) {
    try {
      rows.push({ label: path.split("/").pop() ?? path, design: JSON.parse(readFileSync(path, "utf8")) });
    } catch {
      /* skip missing */
    }
  }

  console.log("design".padEnd(34), "idle$/mo".padStart(9), " verdict   always-on services");
  console.log("-".repeat(92));
  let bloated = 0;
  for (const { label, design } of rows.sort((a, b) => budgetIdleFloor(a.design as never).usd - budgetIdleFloor(b.design as never).usd)) {
    const f = budgetIdleFloor(design as never);
    const v = budgetTierIsCostHonest(design as never);
    if (!v.ok) bloated++;
    const tag = v.ok ? "  ok    " : " BLOATED";
    console.log(label.padEnd(34), ("$" + f.usd.toFixed(2)).padStart(9), tag, " ", f.services.join(", ") || "(serverless)");
  }
  console.log("-".repeat(92));
  console.log(`${rows.length} designs · ${bloated} flagged by budgetTierIsCostHonest (warn-only gate)`);
  db.close();
}

main();
