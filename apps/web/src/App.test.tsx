import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { GenerateResponse, Tier, TierName } from "./lib/types.js";

// jsdom can't run Mermaid's SVG renderer — stub the module to canned SVG.
// `vi.hoisted` lets the hoisted vi.mock factory reference renderMock safely.
const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async (_id: string, chart: string) => ({ svg: `<svg data-len="${chart.length}">mock</svg>` })),
}));
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

import { App } from "./App.js";

function tier(name: TierName, summary: string): Tier {
  return {
    name,
    summary,
    nodes: [
      { id: "client", awsService: "Client", role: "", security: [] },
      { id: "api", awsService: "API Gateway", role: "edge", security: [] },
    ],
    edges: [{ from: "client", to: "api", payload: `${name} JSON request`, protocol: "HTTPS" }],
    delta: [`${name} delta detail`],
    costDrivers: [
      { service: "NAT Gateway", unit: "$0.045/GB processed + $/hr", estimateRange: "$33–$60/mo", note: "required by private-subnet default" },
    ],
    tradeoffs: [`${name} tradeoff`],
  };
}

const baseTiers: Tier[] = [
  tier("budget", "Budget single-AZ design"),
  tier("balanced", "Balanced multi-AZ design"),
  tier("resilient", "Resilient multi-region design"),
];

const SECURITY_FLOOR = ["Encryption at rest with KMS", "Private subnets and least-privilege IAM"];

const fullResult: GenerateResponse = {
  assumptions: ["Prices are AWS on-demand list prices for us-east-1."],
  tiers: baseTiers,
  securityFloor: SECURITY_FLOOR,
  recommendedTier: "budget",
  recommendationRationale: "Budget covers the stated launch traffic with the full security floor.",
  keyDecisions: [
    {
      decision: "Compute model",
      chosen: "Serverless (Lambda + API Gateway)",
      alternativesConsidered: ["ECS Fargate", "EC2 Auto Scaling"],
      rationale: "Lowest idle cost at launch traffic; scales to zero.",
    },
  ],
};

const balancedRecommended: GenerateResponse = {
  ...fullResult,
  recommendedTier: "balanced",
  recommendationRationale: "Balanced is the safest default for mission-critical uptime.",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  renderMock.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function typeAndSubmit(description: string): void {
  fireEvent.change(screen.getByLabelText("System description"), { target: { value: description } });
  fireEvent.click(screen.getByRole("button", { name: /design it/i }));
}

function skipIntake(): void {
  fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
}

describe("App (U10 + E6 intake)", () => {
  it("moves the prompt into the header and shows the intake before generating", () => {
    render(<App />);
    typeAndSubmit("A photo-sharing API");

    // Prompt is now the page goal/header (the textbox is gone).
    expect(screen.getByRole("heading", { name: "A photo-sharing API" })).toBeInTheDocument();
    expect(screen.queryByLabelText("System description")).not.toBeInTheDocument();
    // Intake (E6) is shown once before generation — no fetch yet.
    expect(screen.getByText(/answer 3 quick questions/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skipping the intake generates with no answers and a forced round", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);

    render(<App />);
    typeAndSubmit("A photo-sharing API");
    skipIntake();

    // Loading state visible while the (skipped-answers) request is in flight.
    expect(screen.getByRole("status")).toHaveTextContent(/drafting/i);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.answers).toBeUndefined();
    expect(body.round).toBe(2);

    pending.resolve(jsonResponse(fullResult));
    await screen.findByText("Budget single-AZ design");
  });

  it("answering intake chips passes labeled answers to generate", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("A photo-sharing API");

    fireEvent.click(screen.getByRole("radio", { name: "Millions a day" }));
    fireEvent.click(screen.getByRole("radio", { name: "Mission-critical" }));
    fireEvent.click(screen.getByRole("button", { name: /^design it$/i }));

    await screen.findByText("Budget single-AZ design");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.answers).toEqual([
      "Expected traffic: Millions a day",
      "Downtime tolerance: Mission-critical",
    ]);
    expect(body.round).toBe(2);
  });

  it("leads with a recommendation banner and preselects the recommended tier", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(balancedRecommended));

    render(<App />);
    typeAndSubmit("A REST API");
    skipIntake();

    // Recommendation is the headline.
    const banner = await screen.findByLabelText("Recommendation");
    expect(banner).toHaveTextContent(/Recommended:\s*Balanced/i);
    expect(banner).toHaveTextContent(/safest default/i);

    // Balanced (not the first tier) is auto-selected and badged.
    const balancedTab = screen.getByRole("tab", { name: /balanced/i });
    expect(balancedTab).toHaveAttribute("aria-selected", "true");
    expect(balancedTab).toHaveTextContent(/recommended/i);
    expect(screen.getByText("Balanced multi-AZ design")).toBeInTheDocument();
  });

  it("renders the key-decisions (ADR) card", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("A REST API");
    skipIntake();

    await screen.findByText("Key decisions");
    expect(screen.getByText("Serverless (Lambda + API Gateway)")).toBeInTheDocument();
    // The field label is "Alternatives" (no "considered"), as its own sentence.
    expect(screen.getByText(/Alternatives: ECS Fargate, EC2 Auto Scaling/i)).toBeInTheDocument();
  });

  it("renders clarification questions, then advances to results after answering", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ needsClarification: true, questions: ["Expected traffic?"], round: 1 }))
      .mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("An async job processor");
    skipIntake();

    // Round 1: clarification form.
    const question = await screen.findByText("Expected traffic?");
    expect(question).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "about 100 rps" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Round 2: results render.
    await screen.findByText("Budget single-AZ design");
    expect(screen.getByText("budget delta detail")).toBeInTheDocument();

    // The resubmit carried the answers + advanced round.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.answers).toEqual(["about 100 rps"]);
    expect(secondBody.round).toBe(1);
  });

  it("renders the security floor ONCE globally, not inside each tier", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("A REST API");
    skipIntake();

    await screen.findByText("Budget single-AZ design");
    // The global floor card heading appears exactly once (not per tab).
    expect(screen.getAllByText(/security floor \(applied to every tier\)/i)).toHaveLength(1);
    // "KMS" is wrapped as a glossary term, so match the surrounding floor text.
    expect(screen.getByText(/Encryption at rest with/i)).toBeInTheDocument();
    expect(screen.getByText("KMS")).toBeInTheDocument();

    // Switching tiers does not duplicate the floor — it stays a single global card.
    fireEvent.click(screen.getByRole("tab", { name: /resilient/i }));
    await screen.findByText("Resilient multi-region design");
    expect(screen.getAllByText(/security floor \(applied to every tier\)/i)).toHaveLength(1);
  });

  it("no setup-steps section is rendered (setup moved to the reference config)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("A REST API");
    skipIntake();

    await screen.findByText("Budget single-AZ design");
    expect(screen.queryByText(/^setup steps$/i)).not.toBeInTheDocument();
  });

  it("re-renders diagram + cost + delta when switching tiers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("A REST API");
    skipIntake();

    await screen.findByText("Budget single-AZ design");
    // Budget is framed as minimum safe cost (KTD9) — tier tag.
    expect(screen.getAllByText(/minimum safe cost/i).length).toBeGreaterThan(0);
    // The selected tier surfaces its "what changes" delta.
    expect(screen.getByText("budget delta detail")).toBeInTheDocument();
    expect(renderMock).toHaveBeenCalled();
    const callsAfterBudget = renderMock.mock.calls.length;

    fireEvent.click(screen.getByRole("tab", { name: /balanced/i }));

    await screen.findByText("Balanced multi-AZ design");
    expect(screen.queryByText("Budget single-AZ design")).not.toBeInTheDocument();
    expect(screen.getByText("balanced delta detail")).toBeInTheDocument();
    // The diagram re-rendered for the newly-selected tier.
    await waitFor(() => expect(renderMock.mock.calls.length).toBeGreaterThan(callsAfterBudget));
  });

  it("surfaces a friendly message for a rate-limit error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "rate_limited" }, 429));

    render(<App />);
    typeAndSubmit("Anything");
    skipIntake();

    expect(await screen.findByRole("alert")).toHaveTextContent(/going a little fast/i);
  });
});
