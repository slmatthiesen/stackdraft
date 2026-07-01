import { describe, it, expect, vi } from "vitest";

import { generateStream } from "./api.js";

/** Build a fetch stub returning an SSE stream from the given raw frames (split into two
 *  chunks to exercise the client's cross-chunk frame buffering). */
function sseFetch(frames: string): typeof fetch {
  const mid = Math.floor(frames.length / 2);
  const parts = [frames.slice(0, mid), frames.slice(mid)];
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  const res = {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: stream,
  } as unknown as Response;
  return vi.fn(async () => res) as unknown as typeof fetch;
}

const RESULT = JSON.stringify({
  tiers: [{ name: "budget", summary: "b", nodes: [], edges: [], delta: [], costDrivers: [], tradeoffs: [] }],
  recommendedTier: "budget",
  assumptions: [],
  securityFloor: [],
  keyDecisions: [],
  id: "gen1",
});

describe("generateStream (SSE, fix D)", () => {
  it("reports phase + token + item progress and resolves the result outcome", async () => {
    const frames =
      `event: phase\ndata: {"step":"preparing"}\n\n` +
      `event: phase\ndata: {"step":"generating"}\n\n` +
      `event: item\ndata: {"kind":"decision","label":"Compute model"}\n\n` +
      `event: token\ndata: {"chars":480}\n\n` +
      `event: item\ndata: {"kind":"node","label":"API Gateway"}\n\n` +
      `event: result\ndata: ${RESULT}\n\n`;
    const phases: string[] = [];
    const tokens: number[] = [];
    const items: string[] = [];
    const out = await generateStream(
      { description: "an api" },
      {
        onPhase: (s) => phases.push(s),
        onToken: (c) => tokens.push(c),
        onItem: (it) => items.push(`${it.kind}:${it.label}`),
      },
      sseFetch(frames),
    );
    expect(phases).toEqual(["preparing", "generating"]);
    expect(tokens).toEqual([480]);
    expect(items).toEqual(["decision:Compute model", "node:API Gateway"]);
    expect(out.kind).toBe("result");
    if (out.kind === "result") {
      expect(out.tiers.map((t) => t.name)).toEqual(["budget"]);
      expect(out.id).toBe("gen1");
    }
  });

  it("maps a clarify event to a clarify outcome", async () => {
    const frames = `event: clarify\ndata: {"questions":["Traffic?"],"round":1}\n\n`;
    const out = await generateStream({ description: "x" }, {}, sseFetch(frames));
    expect(out).toEqual({ kind: "clarify", questions: ["Traffic?"], round: 1 });
  });

  it("maps an error event to an error outcome", async () => {
    const frames = `event: error\ndata: {"error":"daily_budget_reached","message":"try tomorrow"}\n\n`;
    const out = await generateStream({ description: "x" }, {}, sseFetch(frames));
    expect(out).toEqual({ kind: "error", status: 0, code: "daily_budget_reached", message: "try tomorrow" });
  });

  it("falls back to JSON when the server does not stream (guard rejection / old server)", async () => {
    const jsonRes = {
      ok: false,
      status: 429,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "rate_limited" }),
    } as unknown as Response;
    const out = await generateStream({ description: "x" }, {}, (vi.fn(async () => jsonRes) as unknown) as typeof fetch);
    expect(out).toEqual({ kind: "error", status: 429, code: "rate_limited", message: undefined });
  });
});
