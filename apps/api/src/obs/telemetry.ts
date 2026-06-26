/**
 * Structured per-request telemetry (R16/U15). One JSON line per request so cache-
 * hit rate, per-request cost, and research volume are observable from logs without
 * a metrics backend. Never include the prompt text or any secret — only counts,
 * booleans, and dollars (the SpendLedger owns spend; this emits the rest).
 */

export interface TelemetryRecord {
  /** Correlates the line with a request; not security-sensitive. */
  requestId: string;
  route: string;
  /** True when served from ResponseCache (no LLM call). */
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Number of research-on-miss web_search calls this request triggered. */
  researchCalls: number;
  latencyMs: number;
  /** USD debited to the spend ledger for this request (0 on cache hit). */
  costUsd: number;
  /** Optional outcome marker: "ok" | "clarify" | "refused" | "error". */
  outcome: string;
}

export type TelemetrySink = (line: string) => void;

const defaultSink: TelemetrySink = (line) => process.stdout.write(line + "\n");

/**
 * Emit one telemetry line as compact JSON. `sink` is injectable so tests can
 * capture the line and the request path can route it to a logger.
 */
export function emitTelemetry(record: TelemetryRecord, sink: TelemetrySink = defaultSink): void {
  sink(JSON.stringify({ kind: "request_telemetry", ...record }));
}

/** Build a record with safe zero-defaults, overridden by `partial`. */
export function telemetryRecord(partial: Partial<TelemetryRecord> & Pick<TelemetryRecord, "requestId" | "route">): TelemetryRecord {
  return {
    cacheHit: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    researchCalls: 0,
    latencyMs: 0,
    costUsd: 0,
    outcome: "ok",
    ...partial,
  };
}
