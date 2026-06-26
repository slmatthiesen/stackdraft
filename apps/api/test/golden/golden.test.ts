import { describe, it, expect, beforeEach } from "vitest";

import { ArchitectureResultSchema } from "../../src/schema/architecture.js";
import { openTempDb, createStores, type Stores } from "../../src/store/sqlite.js";
import { seedKnowledgeBase } from "../../src/store/kbLoader.js";
import { runEval } from "../../src/eval/runner.js";

import { goodArchitecture, badArchitecture, fakeProvider } from "./fixtures.js";
import {
  runAllProperties,
  everyTierCoversAllBaselines,
  allEdgesPayloadLabeled,
  onDemandDisclaimerPresent,
  noBannedServices,
  exactlyThreeTiers,
} from "./properties.js";

const PASS_RATE_FLOOR = 0.9;

describe("golden fixtures", () => {
  it("the known-good fixture is schema-valid", () => {
    expect(() => ArchitectureResultSchema.parse(goodArchitecture())).not.toThrow();
  });
});

describe("property checkers on the known-good result", () => {
  const good = goodArchitecture();

  it("every property passes individually", () => {
    for (const property of [
      exactlyThreeTiers,
      everyTierCoversAllBaselines,
      allEdgesPayloadLabeled,
      onDemandDisclaimerPresent,
      noBannedServices,
    ]) {
      const r = property(good);
      expect(r.ok, `${r.name}: ${r.reason}`).toBe(true);
    }
  });

  it("the aggregator reports ok with all five properties green", () => {
    const agg = runAllProperties(good);
    expect(agg.ok).toBe(true);
    expect(agg.results).toHaveLength(5);
    expect(agg.results.every((r) => r.ok)).toBe(true);
  });
});

describe("property checkers detect the known-bad regression", () => {
  const bad = badArchitecture();

  it("everyTierCoversAllBaselines flips to FAIL when a tier drops a baseline", () => {
    const r = everyTierCoversAllBaselines(bad);
    expect(r.ok).toBe(false);
    // The budget tier specifically lost the audit/access-logging baseline.
    expect(r.reason).toContain("budget:audit-and-access-logging");
  });

  it("the aggregate is not ok for the bad result", () => {
    expect(runAllProperties(bad).ok).toBe(false);
  });
});

describe("runEval over the golden set (fake provider, no network)", () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores);
  });

  it("reports pass-rate 1.0 when the provider emits the known-good result (happy, R16)", async () => {
    const { provider } = fakeProvider(goodArchitecture());

    const report = await runEval({ provider, memory: stores.memory });

    expect(report.total).toBeGreaterThan(0);
    expect(report.passed).toBe(report.total);
    expect(report.passRate).toBe(1);
    expect(report.passRate).toBeGreaterThanOrEqual(PASS_RATE_FLOOR);
    // Every prompt's every property is green.
    for (const p of report.perPrompt) {
      expect(p.ok, p.id).toBe(true);
    }
  });

  it("detects the regression and drops below the gate floor when the provider emits the known-bad result (error, R16)", async () => {
    const { provider } = fakeProvider(badArchitecture());

    const report = await runEval({ provider, memory: stores.memory });

    // The dropped baseline trips every prompt → pass-rate collapses below the floor.
    expect(report.passRate).toBe(0);
    expect(report.passRate).toBeLessThan(PASS_RATE_FLOOR);
    // The specific property that flipped is reported per prompt.
    const sample = report.perPrompt[0];
    expect(sample).toBeDefined();
    const baselineProp = sample?.properties.find((r) => r.name === "everyTierCoversAllBaselines");
    expect(baselineProp?.ok).toBe(false);
  });

  it("respects an injected prompt subset and a custom property aggregator", async () => {
    const { provider } = fakeProvider(goodArchitecture());

    const report = await runEval({
      provider,
      memory: stores.memory,
      prompts: [
        { id: "p1", description: "a serverless api", category: "serverless" },
        { id: "p2", description: "a container api", category: "container" },
      ],
      properties: (result) => ({ ok: true, results: [exactlyThreeTiers(result)] }),
    });

    expect(report.total).toBe(2);
    expect(report.passRate).toBe(1);
  });
});
