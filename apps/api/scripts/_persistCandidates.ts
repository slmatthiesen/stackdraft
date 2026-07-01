/**
 * Persist the preserved corpus candidates (dogfood/corpus-candidates/*.json) into
 * the generations store as `pending` — OFFLINE, no LLM call. Mirrors growCorpus.ts
 * but reads the EXISTING design body from the JSON instead of generating it.
 *
 * Each candidate is re-gated before persisting (it would be served verbatim once
 * approved, so a gate regression must never enter the queue). Descriptions come from
 * GOLDEN_PROMPTS[<id>] for the 7 golden ones and drafture-self.prompt.md for the
 * self-design.
 *
 *   node --import tsx scripts/_persistCandidates.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../src/config.js";
import { getDb, createStores } from "../src/store/sqlite.js";
import { tagDesign } from "../src/pipeline/tags.js";
import { hashPrompt } from "../src/store/responseCache.js";
import { GOLDEN_PROMPTS } from "../test/golden/prompts.js";
import { runAllProperties } from "../test/golden/properties.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

const DIR = join(import.meta.dirname, "../../../dogfood/corpus-candidates");

function descriptionFor(slug: string): string {
  if (slug === "drafture-self") {
    return readFileSync(join(DIR, "drafture-self.prompt.md"), "utf8").trim();
  }
  const golden = GOLDEN_PROMPTS.find((p) => p.id === slug);
  if (!golden) throw new Error(`no GOLDEN_PROMPTS entry for '${slug}'`);
  return golden.description;
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb(config.DB_PATH);
  const stores = createStores(db);

  const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  console.log(`Persisting ${files.length} candidate(s) as pending (offline, no LLM)\n`);

  const persisted: string[] = [];
  for (const file of files) {
    const slug = file.replace(/\.json$/, "");
    const design = JSON.parse(readFileSync(join(DIR, file), "utf8")) as ArchitectureResult;
    const gate = runAllProperties(design);
    if (!gate.ok) {
      const fails = gate.results.filter((r) => !r.ok).map((r) => r.name);
      console.log(`✗ ${slug}  GATE FAIL [${fails.join(", ")}] — NOT persisted`);
      continue;
    }
    const description = descriptionFor(slug);
    const promptHash = hashPrompt({
      description,
      answers: [],
      round: 0,
      model: config.LLM_MODEL,
      region: config.DEFAULT_REGION,
    });
    const { id, status } = await stores.generations.upsert({
      promptHash,
      description,
      answers: [],
      model: config.LLM_MODEL,
      region: config.DEFAULT_REGION,
      recommendedTier: design.recommendedTier,
      tags: tagDesign(design, description),
      body: JSON.stringify(design),
      clientIp: "corpus-candidate",
    });
    persisted.push(id);
    console.log(`✓ ${slug.padEnd(22)} 13/13 → ${id} (${status})  tags: ${tagDesign(design, description).join(", ")}`);
  }

  console.log(`\n${persisted.length}/${files.length} persisted.`);
  if (persisted.length) {
    console.log(`\nApprove all:`);
    for (const id of persisted) console.log(`  node --import tsx scripts/reviewGenerations.ts approve ${id}`);
  }
  db.close();
}

void main();
