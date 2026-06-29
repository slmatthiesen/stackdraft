/**
 * Backfill the semantic learning network's corpus (offline — no model call, no LLM
 * spend; one cheap Voyage embedding call per design, batched).
 *
 * Embeds every APPROVED generation + every curated run into `design_embeddings` so
 * they become retrievable. THIS is the learning step: run it after approving designs
 * (`reviewGenerations.ts approve <id>`) and the corpus grows. Idempotent — skips
 * designs already embedded under the current EMBEDDING_MODEL; pass `--force` to
 * re-embed all (e.g. after switching embedding models).
 *
 * Run:
 *   pnpm --filter @stackdraft/api exec node --env-file=../../.env --import tsx scripts/backfillEmbeddings.ts [--force]
 */
import { getConfig } from "../src/config.js";
import { getDb, createStores } from "../src/store/sqlite.js";
import { buildEmbeddingProvider } from "../src/llm/embeddings/factory.js";
import { embeddingText } from "../src/pipeline/retrieve.js";
import { hashPrompt } from "../src/store/responseCache.js";
import type { DesignSource } from "../src/store/types.js";

interface Pending {
  id: string;
  source: DesignSource;
  promptHash: string;
  text: string;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const config = getConfig();
  const embedder = buildEmbeddingProvider(config);
  if (!embedder) {
    console.error(
      "No embedding provider configured. Set EMBEDDING_PROVIDER=voyage and VOYAGE_API_KEY, then re-run.",
    );
    process.exit(1);
  }

  const db = getDb(config.DB_PATH);
  const stores = createStores(db);

  const pending: Pending[] = [];

  // Approved generations — embed the full prompt (description + intake answers).
  for (const summary of stores.generations.listApproved(10_000)) {
    if (!force && stores.designVectors.hasForModel(summary.id, embedder.model)) continue;
    const rec = stores.generations.getById(summary.id);
    if (!rec) continue;
    pending.push({
      id: rec.id,
      source: "generation",
      promptHash: rec.promptHash,
      text: embeddingText(rec.description, rec.answers),
    });
  }

  // Curated runs — the seeded showcase designs (prompt only; no stored intake answers).
  for (const summary of stores.curated.list()) {
    if (!force && stores.designVectors.hasForModel(summary.id, embedder.model)) continue;
    pending.push({
      id: summary.id,
      source: "curated",
      promptHash: hashPrompt({ description: summary.prompt, answers: [], round: 0, model: config.LLM_MODEL, region: config.DEFAULT_REGION }),
      text: summary.prompt,
    });
  }

  if (pending.length === 0) {
    console.log(`Nothing to embed — corpus is up to date (${stores.designVectors.count(embedder.model)} designs under ${embedder.model}).`);
    db.close();
    return;
  }

  console.log(`Embedding ${pending.length} design(s) with ${embedder.model}…`);
  const vectors = await embedder.embed(pending.map((p) => p.text));
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]!;
    const vector = vectors[i];
    if (!vector) continue;
    stores.designVectors.upsert({ id: p.id, source: p.source, promptHash: p.promptHash, text: p.text, vector, model: embedder.model });
  }

  console.log(`Done. Corpus now holds ${stores.designVectors.count(embedder.model)} design(s) under ${embedder.model}.`);
  db.close();
}

void main();
