/**
 * SQLite backing for the design-embedding corpus (the semantic learning network).
 *
 * One row per embedded design. `search` loads the same-model rows and ranks them by
 * cosine in JS — the corpus is small (curated + approved designs), so brute force is
 * sub-millisecond and needs no vector-index dependency. The vector is stored as a
 * little-endian Float32 BLOB (see vectorMath.ts).
 */
import type { Db, Clock } from "./sqlite.js";
import type { DesignSource, DesignVectorMatch, DesignVectorStore } from "./types.js";
import { blobToVector, cosineSimilarity, vectorToBlob } from "./vectorMath.js";

interface Row {
  id: string;
  source: DesignSource;
  vector: Buffer;
}

export class SqliteDesignVectorStore implements DesignVectorStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  upsert(input: {
    id: string;
    source: DesignSource;
    promptHash: string;
    text: string;
    vector: number[];
    model: string;
  }): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO design_embeddings (id, source, prompt_hash, text, vector, dim, model, created_at)
         VALUES (@id, @source, @promptHash, @text, @vector, @dim, @model, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           source = @source, prompt_hash = @promptHash, text = @text,
           vector = @vector, dim = @dim, model = @model, created_at = @createdAt`,
      )
      .run({
        id: input.id,
        source: input.source,
        promptHash: input.promptHash,
        text: input.text,
        vector: vectorToBlob(input.vector),
        dim: input.vector.length,
        model: input.model,
        createdAt: now,
      });
  }

  hasForModel(id: string, model: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM design_embeddings WHERE id = ? AND model = ?`)
      .get(id, model);
    return row !== undefined;
  }

  count(model: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM design_embeddings WHERE model = ?`)
      .get(model) as { n: number };
    return row.n;
  }

  search(queryVector: number[], model: string, topK: number): DesignVectorMatch[] {
    const rows = this.db
      .prepare(`SELECT id, source, vector FROM design_embeddings WHERE model = ?`)
      .all(model) as Row[];
    const scored = rows.map((r) => ({
      id: r.id,
      source: r.source,
      similarity: cosineSimilarity(queryVector, blobToVector(r.vector)),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  delete(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM design_embeddings WHERE id = ?`).run(id);
    return info.changes > 0;
  }
}
