import { describe, it, expect } from "vitest";

import { emitTelemetry, telemetryRecord, type TelemetryRecord } from "./telemetry.js";

/** Capture sink so we can assert exactly one well-formed JSON line is emitted. */
function captureSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe("emitTelemetry", () => {
  it("emits exactly one JSON line carrying every dimension (integration, R16)", () => {
    const { lines, sink } = captureSink();
    const record: TelemetryRecord = {
      requestId: "req-123",
      route: "/api/generate",
      cacheHit: false,
      inputTokens: 1500,
      outputTokens: 1200,
      cacheReadTokens: 4096,
      cacheWriteTokens: 256,
      researchCalls: 1,
      latencyMs: 842,
      costUsd: 0.0123,
      outcome: "ok",
    };

    emitTelemetry(record, sink);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: "request_telemetry",
      requestId: "req-123",
      route: "/api/generate",
      cacheHit: false,
      inputTokens: 1500,
      outputTokens: 1200,
      cacheReadTokens: 4096,
      cacheWriteTokens: 256,
      researchCalls: 1,
      latencyMs: 842,
      costUsd: 0.0123,
      outcome: "ok",
    });
  });

  it("tags the line so it is greppable in mixed logs", () => {
    const { lines, sink } = captureSink();
    emitTelemetry(telemetryRecord({ requestId: "r", route: "/api/generate" }), sink);
    expect(lines[0]).toContain('"kind":"request_telemetry"');
  });

  it("emits compact single-line JSON (no embedded newlines)", () => {
    const { lines, sink } = captureSink();
    emitTelemetry(telemetryRecord({ requestId: "r", route: "/api/generate" }), sink);
    expect(lines[0]).not.toContain("\n");
  });

  it("never leaks prompt text or secrets — only the declared numeric/boolean dims", () => {
    const { lines, sink } = captureSink();
    emitTelemetry(telemetryRecord({ requestId: "r", route: "/api/generate" }), sink);
    const keys = Object.keys(JSON.parse(lines[0] as string) as Record<string, unknown>).sort();
    expect(keys).toEqual(
      [
        "cacheHit",
        "cacheReadTokens",
        "cacheWriteTokens",
        "costUsd",
        "inputTokens",
        "kind",
        "latencyMs",
        "outcome",
        "outputTokens",
        "requestId",
        "researchCalls",
        "route",
      ].sort(),
    );
  });
});

describe("telemetryRecord", () => {
  it("fills safe zero-defaults when only the required dims are provided", () => {
    const record = telemetryRecord({ requestId: "req-9", route: "/api/clarify" });
    expect(record).toEqual({
      requestId: "req-9",
      route: "/api/clarify",
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      researchCalls: 0,
      latencyMs: 0,
      costUsd: 0,
      outcome: "ok",
    });
  });

  it("lets partial fields override the defaults", () => {
    const record = telemetryRecord({
      requestId: "req-9",
      route: "/api/generate",
      cacheHit: true,
      outcome: "refused",
      costUsd: 0,
    });
    expect(record.cacheHit).toBe(true);
    expect(record.outcome).toBe("refused");
    // Untouched fields keep their zero-defaults.
    expect(record.inputTokens).toBe(0);
    expect(record.researchCalls).toBe(0);
  });
});
