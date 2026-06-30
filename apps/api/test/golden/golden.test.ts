import { describe, it, expect, beforeEach } from "vitest";

import { ArchitectureResultSchema } from "../../src/schema/architecture.js";
import { openTempDb, createStores, type Stores } from "../../src/store/sqlite.js";
import { seedKnowledgeBase } from "../../src/store/kbLoader.js";
import { runEval } from "../../src/eval/runner.js";

import {
  goodArchitecture,
  badArchitecture,
  incoherentComputeArchitecture,
  incoherentDatastoreArchitecture,
  alertOnlySnsArchitecture,
  fakeProvider,
} from "./fixtures.js";
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
  computeMatchesDecision,
  datastoreMatchesDecision,
  graphHasNoDanglingEdges,
  primaryDatastoreReachable,
  graphHasNoOrphanNodes,
  readPathWhenUiImplied,
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
      computeMatchesDecision,
      datastoreMatchesDecision,
      graphHasNoDanglingEdges,
      primaryDatastoreReachable,
      graphHasNoOrphanNodes,
      readPathWhenUiImplied,
    ]) {
      const r = property(good);
      expect(r.ok, `${r.name}: ${r.reason}`).toBe(true);
    }
  });

  it("the aggregator reports ok with all thirteen gated properties green", () => {
    const agg = runAllProperties(good);
    expect(agg.ok).toBe(true);
    // readPathWhenUiImplied is warn-only (not in ALL_PROPERTIES yet), so the gate
    // holds thirteen, not the fourteen exported checkers.
    expect(agg.results).toHaveLength(13);
    expect(agg.results.every((r) => r.ok)).toBe(true);
  });
});

describe("completeness critic flips to FAIL on a structurally-broken graph", () => {
  it("graphHasNoDanglingEdges fails when an edge references a missing node id", () => {
    const broken = structuredClone(goodArchitecture());
    broken.tiers[0]!.edges.push({ from: "client", to: "ghost_node", payload: "x", protocol: "HTTPS" });
    expect(graphHasNoDanglingEdges(broken).ok).toBe(false);
    expect(graphHasNoDanglingEdges(goodArchitecture()).ok).toBe(true);
  });

  it("primaryDatastoreReachable fails when a primary datastore has no edges", () => {
    const broken = structuredClone(goodArchitecture());
    broken.tiers[0]!.nodes.push({ id: "orphan_db", awsService: "DynamoDB", role: "unwired store", security: ["KMS at rest"] });
    expect(primaryDatastoreReachable(broken).ok).toBe(false);
    expect(primaryDatastoreReachable(goodArchitecture()).ok).toBe(true);
  });

  it("graphHasNoOrphanNodes fails on an unwired active node but exempts an S3 asset sink", () => {
    const broken = structuredClone(goodArchitecture());
    // An always-on compute node the delta forgot to wire — a real orphan.
    broken.tiers[0]!.nodes.push({ id: "orphan_fn", awsService: "Lambda", role: "stray worker", security: ["least-priv role"] });
    expect(graphHasNoOrphanNodes(broken).ok).toBe(false);
    expect(graphHasNoOrphanNodes(goodArchitecture()).ok).toBe(true);

    // A passive S3 sink with no edge is NOT an orphan (asset/audit destination).
    const withSink = structuredClone(goodArchitecture());
    withSink.tiers[0]!.nodes.push({ id: "audit", awsService: "S3", role: "access-log sink", security: ["block public access"] });
    expect(graphHasNoOrphanNodes(withSink).ok).toBe(true);
  });

  it("isolates the defect: only graphHasNoOrphanNodes fails on an orphaned active node", () => {
    const broken = structuredClone(goodArchitecture());
    broken.tiers[0]!.nodes.push({ id: "orphan_fn", awsService: "Lambda", role: "stray worker", security: ["least-priv role"] });
    const failing = runAllProperties(broken).results.filter((r) => !r.ok).map((r) => r.name);
    expect(failing).toEqual(["graphHasNoOrphanNodes"]);
  });

  it("readPathWhenUiImplied (warn-only) fails when a UI tier's datastore has no compute neighbor", () => {
    const broken = structuredClone(goodArchitecture());
    // Drop the fn→db edge so the DynamoDB store is wired only to nothing-compute.
    const t = broken.tiers[0]!;
    t.edges = t.edges.filter((e) => !(e.from === "fn" && e.to === "db"));
    // Wire db to a non-compute node so it isn't ALSO a primaryDatastoreReachable failure.
    t.edges.push({ from: "db", to: "assets", payload: "export", protocol: "HTTPS" });
    expect(readPathWhenUiImplied(broken).ok).toBe(false);
    expect(readPathWhenUiImplied(goodArchitecture()).ok).toBe(true);
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

describe("queuesAreResilient does not mis-flag an SNS alarm-notifier as a work queue", () => {
  const alertOnly = alertOnlySnsArchitecture();

  it("passes: an SNS *alarm notifier* (no work queue) is not a DLQ/idempotency offender", () => {
    const r = queuesAreResilient(alertOnly);
    expect(r.ok, r.reason).toBe(true);
  });

  it("the whole aggregate is clean for the alert-only serverless design", () => {
    expect(runAllProperties(alertOnly).ok).toBe(true);
  });
});

describe("computeMatchesDecision detects the serverless-decision / always-on-nodes contradiction", () => {
  const incoherent = incoherentComputeArchitecture();

  it("passes on the coherent good fixture (serverless decision + Lambda nodes)", () => {
    expect(computeMatchesDecision(goodArchitecture()).ok).toBe(true);
  });

  it("flips to FAIL when the keyDecision chose Lambda but the tiers run EC2 + ALB", () => {
    const r = computeMatchesDecision(incoherent);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/serverless/i);
    expect(r.reason).toMatch(/EC2/);
  });

  it("isolates the defect: only computeMatchesDecision fails on the incoherent fixture", () => {
    const failing = runAllProperties(incoherent).results.filter((r) => !r.ok).map((r) => r.name);
    expect(failing).toEqual(["computeMatchesDecision"]);
  });
});

describe("datastoreMatchesDecision detects the serverless-decision / VPC-bound-store contradiction", () => {
  const incoherent = incoherentDatastoreArchitecture();

  it("passes on the coherent good fixture (DynamoDB decision + DynamoDB nodes)", () => {
    expect(datastoreMatchesDecision(goodArchitecture()).ok).toBe(true);
  });

  it("flips to FAIL when the keyDecision chose DynamoDB but the tiers run RDS", () => {
    const r = datastoreMatchesDecision(incoherent);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/serverless/i);
    expect(r.reason).toMatch(/RDS/);
  });

  it("isolates the defect: only datastoreMatchesDecision fails on the incoherent fixture", () => {
    const failing = runAllProperties(incoherent).results.filter((r) => !r.ok).map((r) => r.name);
    expect(failing).toEqual(["datastoreMatchesDecision"]);
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

    const report = await runEval({ provider, memory: stores.memory, pricing: stores.pricing });

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

    const report = await runEval({ provider, memory: stores.memory, pricing: stores.pricing });

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
      pricing: stores.pricing,
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
