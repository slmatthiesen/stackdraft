import { describe, it, expect, beforeEach } from "vitest";

import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../llm/embeddings/provider.js";
import { EmbeddingError } from "../llm/embeddings/provider.js";
import { openTempDb, createStores, type Db, type Stores } from "../store/sqlite.js";
import { retrieveSimilarDesigns, renderExemplars, embeddingText } from "./retrieve.js";

const MODEL = "voyage-3-lite";

/** Minimal config carrying only the thresholds retrieve.ts reads. */
const cfg = (): Config =>
  ({
    SEMANTIC_RETURN_THRESHOLD: 0.93,
    SEMANTIC_GROUND_THRESHOLD: 0.82,
    SEMANTIC_GROUND_TOPK: 3,
  }) as unknown as Config;

/** A controllable embedder: returns whatever vector the test maps each text to. */
function fakeEmbedder(map: Record<string, number[]>): EmbeddingProvider {
  return { model: MODEL, embed: async (texts) => texts.map((t) => map[t] ?? [0, 0, 0]) };
}

const designBody = (tag: string) =>
  JSON.stringify({
    recommendedTier: "balanced",
    recommendationRationale: "",
    assumptions: [],
    securityFloor: [],
    keyDecisions: [{ decision: `compute for ${tag}`, chosen: "Lambda", alternativesConsidered: [], rationale: "r" }],
    tiers: [{ name: "budget", summary: `${tag} baseline`, nodes: [], edges: [], delta: [], tradeoffs: [], costDrivers: [] }],
  });

/** Seed an APPROVED generation + its embedding vector. Returns the id. */
function seedApproved(stores: Stores, desc: string, vector: number[]): string {
  const { id } = stores.generations.upsert({
    promptHash: `ph-${desc}`,
    description: desc,
    answers: [],
    model: "claude-sonnet-4-6",
    region: "us-east-1",
    recommendedTier: "balanced",
    tags: [],
    body: designBody(desc),
    clientIp: "1.1.1.1",
  });
  stores.generations.setStatus(id, "approved");
  stores.designVectors.upsert({ id, source: "generation", promptHash: `ph-${desc}`, text: desc, vector, model: MODEL });
  return id;
}

describe("retrieveSimilarDesigns", () => {
  let db: Db;
  let stores: Stores;

  beforeEach(() => {
    db = openTempDb();
    stores = createStores(db);
  });

  it("serves an instant hit when the nearest design clears RETURN_THRESHOLD", async () => {
    const id = seedApproved(stores, "a notification system", [1, 0, 0]);
    const res = await retrieveSimilarDesigns({
      embedder: fakeEmbedder({ "send me alerts": [1, 0, 0] }), // identical → cosine 1
      stores,
      config: cfg(),
      description: "send me alerts",
      answers: [],
    });
    expect(res.instant?.id).toBe(id);
    expect(res.topSimilarity).toBeCloseTo(1, 5);
    expect(res.exemplars).toHaveLength(0);
  });

  it("returns exemplars (not an instant hit) when similarity is in the grounding band", async () => {
    seedApproved(stores, "a notification system", [1, 0, 0]);
    // cosine([0.85, 0.5267, 0], [1,0,0]) ≈ 0.85 → in [0.82, 0.93)
    const res = await retrieveSimilarDesigns({
      embedder: fakeEmbedder({ "an alerting pipeline": [0.85, 0.5267, 0] }),
      stores,
      config: cfg(),
      description: "an alerting pipeline",
      answers: [],
    });
    expect(res.instant).toBeNull();
    expect(res.exemplars).toHaveLength(1);
    expect(res.topSimilarity).toBeGreaterThan(0.82);
    expect(res.topSimilarity).toBeLessThan(0.93);
  });

  it("returns nothing when the nearest design is below GROUND_THRESHOLD", async () => {
    seedApproved(stores, "a notification system", [1, 0, 0]);
    const res = await retrieveSimilarDesigns({
      embedder: fakeEmbedder({ "a video transcoder": [0.5, 0.866, 0] }), // cosine 0.5
      stores,
      config: cfg(),
      description: "a video transcoder",
      answers: [],
    });
    expect(res.instant).toBeNull();
    expect(res.exemplars).toHaveLength(0);
  });

  it("never serves a design that is no longer approved", async () => {
    const id = seedApproved(stores, "a notification system", [1, 0, 0]);
    stores.generations.setStatus(id, "hidden"); // crowd-downvoted out of the gallery
    const res = await retrieveSimilarDesigns({
      embedder: fakeEmbedder({ "send me alerts": [1, 0, 0] }),
      stores,
      config: cfg(),
      description: "send me alerts",
      answers: [],
    });
    expect(res.instant).toBeNull();
    expect(res.exemplars).toHaveLength(0);
  });

  it("degrades to no retrieval when there is no embedder", async () => {
    seedApproved(stores, "a notification system", [1, 0, 0]);
    const res = await retrieveSimilarDesigns({ embedder: null, stores, config: cfg(), description: "x", answers: [] });
    expect(res).toEqual({ instant: null, exemplars: [], topSimilarity: 0 });
  });

  it("is non-fatal on an embedding error (falls through to a normal generation)", async () => {
    seedApproved(stores, "a notification system", [1, 0, 0]);
    const failing: EmbeddingProvider = {
      model: MODEL,
      embed: async () => {
        throw new EmbeddingError("voyage down");
      },
    };
    const res = await retrieveSimilarDesigns({ embedder: failing, stores, config: cfg(), description: "x", answers: [] });
    expect(res.instant).toBeNull();
    expect(res.exemplars).toHaveLength(0);
  });

  it("renderExemplars produces a dense reference block with decisions + tiers", () => {
    seedApproved(stores, "a notification system", [0.85, 0.5267, 0]);
    const out = renderExemplars([
      { id: "x", source: "generation", prompt: "a notification system", body: JSON.parse(designBody("notif")), similarity: 0.85 },
    ]);
    expect(out).toContain("Similar designs we've shipped");
    expect(out).toContain("a notification system");
    expect(out).toContain("compute for notif → Lambda");
  });

  it("embeddingText joins description + answers identically on read and write paths", () => {
    expect(embeddingText("desc", ["a: 1", "b: 2"])).toBe("desc\na: 1\nb: 2");
  });
});
