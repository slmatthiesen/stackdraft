import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteDesignVectorStore } from "./designVectors.js";

const clock: Clock = { now: () => 1_000 };

const rec = (id: string, vector: number[], model = "voyage-3-lite") => ({
  id,
  source: "curated" as const,
  promptHash: `hash-${id}`,
  text: `prompt ${id}`,
  vector,
  model,
});

describe("SqliteDesignVectorStore", () => {
  let db: Db;
  let store: SqliteDesignVectorStore;

  beforeEach(() => {
    db = openTempDb();
    store = new SqliteDesignVectorStore(db, clock);
  });

  it("upsert + search ranks the nearest vector first", () => {
    store.upsert(rec("a", [1, 0, 0]));
    store.upsert(rec("b", [0, 1, 0]));
    store.upsert(rec("c", [0.9, 0.1, 0]));

    const hits = store.search([1, 0, 0], "voyage-3-lite", 2);
    expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
    expect(hits[0]!.similarity).toBeCloseTo(1, 5);
    expect(hits[1]!.similarity).toBeGreaterThan(hits[1]!.similarity - 1); // c is close but < a
    expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity);
  });

  it("upsert overwrites by id (re-embedding replaces the vector)", () => {
    store.upsert(rec("a", [1, 0, 0]));
    store.upsert(rec("a", [0, 1, 0]));
    expect(store.count("voyage-3-lite")).toBe(1);
    const [hit] = store.search([0, 1, 0], "voyage-3-lite", 1);
    expect(hit!.similarity).toBeCloseTo(1, 5);
  });

  it("search only compares vectors from the SAME model (never mixes spaces)", () => {
    store.upsert(rec("a", [1, 0, 0], "voyage-3-lite"));
    store.upsert(rec("b", [1, 0, 0], "other-model"));
    expect(store.count("voyage-3-lite")).toBe(1);
    expect(store.search([1, 0, 0], "voyage-3-lite", 5)).toHaveLength(1);
    expect(store.search([1, 0, 0], "voyage-3-lite", 5)[0]!.id).toBe("a");
  });

  it("hasForModel reports whether a design is embedded under a model", () => {
    store.upsert(rec("a", [1, 0, 0], "voyage-3-lite"));
    expect(store.hasForModel("a", "voyage-3-lite")).toBe(true);
    expect(store.hasForModel("a", "other-model")).toBe(false);
    expect(store.hasForModel("missing", "voyage-3-lite")).toBe(false);
  });

  it("delete removes a row", () => {
    store.upsert(rec("a", [1, 0, 0]));
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.count("voyage-3-lite")).toBe(0);
  });
});
