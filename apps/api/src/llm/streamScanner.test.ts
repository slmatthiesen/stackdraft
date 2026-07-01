import { describe, it, expect } from "vitest";

import { StreamItemScanner, type ScannedItem } from "./streamScanner.js";

// A realistic budget-wire object in the schema's field order: assumptions +
// clarificationsUsed (string arrays), keyDecisions (objects), then baseTier with
// nodes + edges (objects). Only the element objects should surface as items.
const WIRE = {
  assumptions: ["single region us-east-1", "traffic ~<50k/mo"],
  clarificationsUsed: [],
  keyDecisions: [
    { decision: "Compute model", chosen: "Lambda", alternativesConsidered: ["Fargate", "EC2"], rationale: "scales to zero" },
    { decision: "Datastore", chosen: "DynamoDB", alternativesConsidered: ["RDS"], rationale: "on-demand" },
  ],
  baseTier: {
    name: "budget",
    summary: "single-AZ serverless",
    nodes: [
      { id: "gw", awsService: "API Gateway", role: "front door", security: ["TLS", "throttling"] },
      { id: "fn", awsService: "Lambda", role: "api logic", security: ["least-priv role"] },
      { id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["SSE", "on-demand"] },
    ],
    edges: [
      { from: "client", to: "gw", payload: "JSON request", protocol: "HTTPS" },
      { from: "gw", to: "fn", payload: "invoke", protocol: "HTTPS" },
    ],
    delta: ["baseline"],
    tradeoffs: ["cheapest correct"],
  },
};

function scanInChunks(json: string, size: number): ScannedItem[] {
  const scanner = new StreamItemScanner();
  const items: ScannedItem[] = [];
  for (let i = 0; i < json.length; i += size) items.push(...scanner.push(json.slice(i, i + size)));
  return items;
}

describe("StreamItemScanner", () => {
  it("surfaces each key decision, node, and edge — and NOT the container objects", () => {
    const items = scanInChunks(JSON.stringify(WIRE), 9999);
    expect(items).toEqual([
      { kind: "decision", label: "Compute model" },
      { kind: "decision", label: "Datastore" },
      { kind: "node", label: "API Gateway" },
      { kind: "node", label: "Lambda" },
      { kind: "node", label: "DynamoDB" },
      { kind: "edge", label: "client → gw" },
      { kind: "edge", label: "gw → fn" },
    ]);
    // The root and baseTier objects are NOT array elements → never emitted.
    expect(items.some((i) => i.label === "budget")).toBe(false);
  });

  it("is chunk-boundary-agnostic — 1-char pieces yield the same items", () => {
    const whole = scanInChunks(JSON.stringify(WIRE), 100000);
    const oneByOne = scanInChunks(JSON.stringify(WIRE), 1);
    expect(oneByOne).toEqual(whole);
  });

  it("handles pretty-printed JSON and strings containing braces/brackets", () => {
    const wire = {
      keyDecisions: [{ decision: "Escaping {and} [brackets]", chosen: "x", alternativesConsidered: [], rationale: "y" }],
      baseTier: {
        nodes: [{ id: "n", awsService: "S3 (with, commas)", role: "store", security: [] }],
        edges: [],
      },
    };
    const items = scanInChunks(JSON.stringify(wire, null, 2), 3);
    expect(items).toEqual([
      { kind: "decision", label: "Escaping {and} [brackets]" },
      { kind: "node", label: "S3 (with, commas)" },
    ]);
  });

  it("drops a malformed/partial capture without throwing", () => {
    const scanner = new StreamItemScanner();
    // A truncated stream (object never closes) yields nothing, no throw.
    expect(scanner.push('{"keyDecisions":[{"decision":"half')).toEqual([]);
  });
});
