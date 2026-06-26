import { describe, it, expect, beforeEach } from "vitest";
import { loadHistory, addHistory, removeHistory, clearHistory } from "./history.js";
import type { GenerateResponse } from "./types.js";

function result(tier: GenerateResponse["recommendedTier"] = "balanced"): GenerateResponse {
  return {
    tiers: [],
    assumptions: [],
    securityFloor: [],
    recommendedTier: tier,
    recommendationRationale: "",
    keyDecisions: [],
  };
}

describe("design history (localStorage)", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty and saves newest-first", () => {
    expect(loadHistory()).toEqual([]);
    addHistory("a photo app", result("budget"));
    const after = addHistory("a job queue", result("resilient"));
    expect(after.map((e) => e.prompt)).toEqual(["a job queue", "a photo app"]);
    expect(loadHistory().map((e) => e.prompt)).toEqual(["a job queue", "a photo app"]);
  });

  it("de-dupes by prompt, keeping the newest", () => {
    addHistory("same prompt", result("budget"));
    const after = addHistory("same prompt", result("resilient"));
    expect(after).toHaveLength(1);
    expect(after[0]!.result.recommendedTier).toBe("resilient");
  });

  it("removes and clears entries", () => {
    addHistory("p1", result());
    const two = addHistory("p2", result());
    const afterRemove = removeHistory(two[0]!.id);
    expect(afterRemove.map((e) => e.prompt)).toEqual(["p1"]);
    expect(clearHistory()).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });

  it("survives a fresh load (persists to storage)", () => {
    addHistory("persisted", result());
    expect(loadHistory().map((e) => e.prompt)).toEqual(["persisted"]);
  });
});
