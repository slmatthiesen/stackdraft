import { describe, it, expect, vi } from "vitest";

import { addTier } from "./api.js";
import type { Tier } from "./types.js";

const budgetTier: Tier = {
  name: "budget",
  summary: "single box",
  nodes: [{ id: "api", awsService: "EC2", role: "host", security: [] }],
  edges: [{ from: "client", to: "api", payload: "req", protocol: "HTTPS" }],
  delta: [],
  costDrivers: [],
  tradeoffs: [],
};

const balancedTier: Tier = { ...budgetTier, name: "balanced", summary: "multi-AZ" };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("addTier client", () => {
  it("posts the budget baseline + target and returns the costed tier", async () => {
    let sentBody = "";
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      sentBody = (init?.body as string) ?? "";
      return Promise.resolve(jsonResponse({ tier: balancedTier }));
    });
    const out = await addTier(
      { description: "an api", tier: "balanced", budgetTier, generationId: "g1" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(out).toEqual({ kind: "tier", tier: balancedTier });
    expect(JSON.parse(sentBody)).toMatchObject({
      tier: "balanced",
      generationId: "g1",
      budgetTier: { name: "budget" },
    });
  });

  it("maps a non-2xx body to an error outcome", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "daily_budget_reached" }, 503));
    const out = await addTier(
      { description: "x", tier: "resilient", budgetTier },
      fetchImpl as unknown as typeof fetch,
    );
    expect(out).toEqual({ kind: "error", status: 503, code: "daily_budget_reached", message: undefined });
  });

  it("returns a transport error without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const out = await addTier(
      { description: "x", tier: "balanced", budgetTier },
      fetchImpl as unknown as typeof fetch,
    );
    expect(out).toEqual({ kind: "error", status: 0, code: "network_error" });
  });
});
