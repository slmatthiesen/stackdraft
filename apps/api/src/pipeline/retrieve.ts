/**
 * Semantic retrieval (the learning network's read path) — RAG over our own
 * approved designs.
 *
 * Embeds the incoming prompt, ranks the same-model corpus by cosine, and classifies
 * the best match:
 *   - similarity ≥ RETURN_THRESHOLD → an `instant` hit: serve that design verbatim
 *     (re-costed downstream), $0 + no LLM call.
 *   - GROUND_THRESHOLD ≤ similarity < RETURN_THRESHOLD → `exemplars`: inject the
 *     nearest designs into the generation prompt so the model converges faster and
 *     more consistently.
 *
 * EVERY failure here is non-fatal: no embedder, an embedding error, a corpus miss,
 * or an unreadable body all degrade to "no retrieval" so the normal generate path
 * runs. The learning network only ever helps — it never blocks a generation.
 */
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../llm/embeddings/provider.js";
import { EmbeddingError } from "../llm/embeddings/provider.js";
import type { ArchitectureResult } from "../schema/architecture.js";
import type {
  CuratedStore,
  DesignSource,
  DesignVectorStore,
  GenerationsStore,
} from "../store/types.js";

/** A design pulled from the corpus, body parsed and ready to serve or quote. */
export interface SimilarDesign {
  id: string;
  source: DesignSource;
  /** Curated title when present; undefined for user generations. */
  title?: string;
  prompt: string;
  body: ArchitectureResult;
  similarity: number;
}

export interface RetrievalResult {
  /** A near-exact match to serve verbatim ($0, no LLM). Null below RETURN_THRESHOLD. */
  instant: SimilarDesign | null;
  /** Adjacent designs to ground a fresh generation (empty when retrieval is off/cold). */
  exemplars: SimilarDesign[];
  /** Best cosine seen (telemetry); 0 when retrieval did not run. */
  topSimilarity: number;
}

const EMPTY: RetrievalResult = { instant: null, exemplars: [], topSimilarity: 0 };

/** The text we embed for a prompt — identical on the write path (backfill) and read path. */
export function embeddingText(description: string, answers: string[]): string {
  return [description, ...answers].join("\n");
}

interface RetrieveStores {
  designVectors: DesignVectorStore;
  generations: GenerationsStore;
  curated: CuratedStore;
}

export async function retrieveSimilarDesigns(input: {
  embedder: EmbeddingProvider | null;
  stores: RetrieveStores;
  config: Config;
  description: string;
  answers: string[];
}): Promise<RetrievalResult> {
  const { embedder, stores, config } = input;
  if (!embedder) return EMPTY;

  let queryVector: number[];
  try {
    const [vec] = await embedder.embed([embeddingText(input.description, input.answers)]);
    if (!vec) return EMPTY;
    queryVector = vec;
  } catch (err) {
    if (err instanceof EmbeddingError) return EMPTY; // non-fatal — fall through to a normal generation
    throw err;
  }

  const topK = Math.max(config.SEMANTIC_GROUND_TOPK, 1);
  const matches = stores.designVectors.search(queryVector, embedder.model, topK);
  if (matches.length === 0) return EMPTY;

  const topSimilarity = matches[0]?.similarity ?? 0;

  // Instant serve: the single closest design, only if it clears RETURN_THRESHOLD.
  if (topSimilarity >= config.SEMANTIC_RETURN_THRESHOLD) {
    const best = matches[0]!;
    const design = loadDesign(stores, best.id, best.source, best.similarity);
    if (design) return { instant: design, exemplars: [], topSimilarity };
    // Body unreadable (deleted/corrupt) — fall through to grounding/normal gen.
  }

  // Grounding: adjacent designs in the [GROUND, RETURN) band become prompt exemplars.
  const exemplars: SimilarDesign[] = [];
  for (const m of matches) {
    if (m.similarity < config.SEMANTIC_GROUND_THRESHOLD) break; // sorted desc — rest are further
    if (m.similarity >= config.SEMANTIC_RETURN_THRESHOLD) continue; // would have been an instant hit
    const design = loadDesign(stores, m.id, m.source, m.similarity);
    if (design) exemplars.push(design);
  }
  return { instant: null, exemplars, topSimilarity };
}

function loadDesign(
  stores: RetrieveStores,
  id: string,
  source: DesignSource,
  similarity: number,
): SimilarDesign | null {
  try {
    if (source === "curated") {
      const run = stores.curated.get(id);
      if (!run) return null;
      return { id, source, title: run.title, prompt: run.prompt, body: JSON.parse(run.body), similarity };
    }
    const rec = stores.generations.getById(id);
    if (!rec || rec.status !== "approved") return null; // never serve a non-public design
    return { id, source, prompt: rec.description, body: JSON.parse(rec.body), similarity };
  } catch {
    return null; // unparseable body — skip, never throw mid-request
  }
}

/**
 * Render adjacent designs as a compact prompt section: each design's prompt + its
 * load-bearing decisions and tier shapes. DENSE on purpose — the point is to steer
 * the model toward our house patterns, not to dump full graphs back into the prompt
 * (that would inflate input tokens for little gain).
 */
export function renderExemplars(exemplars: SimilarDesign[]): string | undefined {
  if (exemplars.length === 0) return undefined;
  const blocks = exemplars.map((d) => {
    const decisions = (d.body.keyDecisions ?? [])
      .map((k) => `  - ${k.decision} → ${k.chosen}`)
      .join("\n");
    const tiers = (d.body.tiers ?? [])
      .map((t) => `  - ${t.name}: ${t.summary}`)
      .join("\n");
    return `### A prior design for: "${d.prompt}"\nKey decisions:\n${decisions}\nTiers:\n${tiers}`;
  });
  return (
    `## Similar designs we've shipped (REFERENCE — reuse the patterns and service choices that fit; ` +
    `adapt to THIS request, do not copy verbatim)\n${blocks.join("\n\n")}`
  );
}
