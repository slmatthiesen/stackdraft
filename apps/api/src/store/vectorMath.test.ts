import { describe, it, expect } from "vitest";

import { vectorToBlob, blobToVector, cosineSimilarity } from "./vectorMath.js";

describe("vectorMath", () => {
  it("round-trips a vector through the BLOB encoding (Float32 precision)", () => {
    const vec = [0.1, -0.5, 1.0, 0.0, 0.333333];
    const back = blobToVector(vectorToBlob(vec));
    expect(back).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(back[i]).toBeCloseTo(vec[i]!, 5);
    }
  });

  it("cosine of a vector with itself is 1", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it("cosine of orthogonal vectors is 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("cosine of opposite vectors is -1", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
  });

  it("returns 0 (not NaN) for a zero-magnitude vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for a dimension mismatch (different embedding model) — never throws", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });
});
