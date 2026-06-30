/**
 * Vector helpers for the design-embedding store: Float32 ↔ SQLite BLOB and cosine
 * similarity. The corpus is small (curated + approved designs, < ~1k rows), so a
 * brute-force cosine scan in JS is sub-millisecond — no vector index needed yet
 * (a future ANN index drops in behind DesignVectorStore.search without callers
 * changing).
 */

/** Pack a vector into a little-endian Float32 Buffer for storage as a SQLite BLOB. */
export function vectorToBlob(vec: number[]): Buffer {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Read a Float32 BLOB back into a number[]. Copies, so the underlying Buffer is safe to reuse. */
export function blobToVector(blob: Buffer): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 for a zero-magnitude vector (degenerate,
 * never a real embedding) and for a length mismatch (a different embedding model /
 * dimension — treat as "not comparable", never throw mid-request).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
