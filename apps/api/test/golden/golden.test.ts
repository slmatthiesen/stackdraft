import { describe, it, expect, beforeEach } from "vitest";

import { ArchitectureResultSchema } from "../../src/schema/architecture.js";
import { openTempDb, createStores, type Stores } from "../../src/store/sqlite.js";
import { seedKnowledgeBase } from "../../src/store/kbLoader.js";
import { runEval } from "../../src/eval/runner.js";

import { goodArchitecture, badArchitecture, fakeProvider } from "./fixtures.js";
import {
  runAllProperties,
  securityFloorCoversAllBaselines,
  allEdgesPayloadLabeled,
  onDemandDisclaimerPresent,
  noBannedServices,
  exactlyThreeTiers,
  recommendsATier,
  hasKeyDecisions,
  queuesAreResilient,
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
      securityFloorCoversAllBaselines,
      allEdgesPayloadLabeled,
      onDemandDisclaimerPresent,
      noBannedServices,
      recommendsATier,
      hasKeyDecisions,
      queuesAreResilient,
    ]) {
      const r = property(good);
      expect(r.ok, `${r.name}: ${r.reason}`).toBe(true);
    }
  });

  it("the aggregator reports ok with all eight properties green", () => {
    const agg = runAllProperties(good);
    expect(agg.ok).toBe(true);
    expect(agg.results).toHaveLength(8);
    expect(agg.results.every((r) => r.ok)).toBe(true);
  });
});

describe("property checkers detect the known-bad regression", () => {
  const bad = badArchitecture();

  it("securityFloorCoversAllBaselines flips to FAIL when the floor drops a baseline", () => {
    const r = securityFloorCoversAllBaselines(bad);
    expect(r.ok).toBe(false);
    // The global floor specifically lost the audit/access-logging baseline.
    expect(r.reason).toContain("audit-and-access-logging");
  });

  it("queuesAreResilient flips to FAIL when a queue-bearing tier drops DLQ + idempotency", () => {
    const r = queuesAreResilient(bad);
    expect(r.ok).toBe(false);
    // Each tier keeps its SQS node but lost the dead-letter + idempotency reasoning.
    expect(r.reason).toMatch(/dead-letter|DLQ/i);
    expect(r.reason).toMatch(/idempotenc|dedupe/i);
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

    // The dropped queue resilience trips every prompt → pass-rate collapses below
    // the floor. NOTE: the security floor is now injected DETERMINISTICALLY by the
    // pipeline, so a model can no longer regress it — `securityFloorCoversAllBaselines`
    // is correct by construction through generation. The gate's regression-detection
    // is therefore demonstrated via a property that IS still model-controlled
    // (queue DLQ + idempotency), which is the realistic regression surface now.
    expect(report.passRate).toBe(0);
    expect(report.passRate).toBeLessThan(PASS_RATE_FLOOR);
    // The specific property that flipped is reported per prompt.
    const sample = report.perPrompt[0];
    expect(sample).toBeDefined();
    const queueProp = sample?.properties.find((r) => r.name === "queuesAreResilient");
    expect(queueProp?.ok).toBe(false);
    // And the deterministic floor still passes through generation (correct by construction).
    const floorProp = sample?.properties.find((r) => r.name === "securityFloorCoversAllBaselines");
    expect(floorProp?.ok).toBe(true);
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
