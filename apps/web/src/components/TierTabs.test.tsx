import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TierTabs } from "./TierTabs.js";
import type { Tier } from "../lib/types.js";

// A budget tier whose only adjustable driver is an EC2 $/hr box the SERVER already
// priced at t4g.small (~$12–$25/mo) and stamped with that instanceType. There is no
// client auto-seeding now — the cheap band comes straight from the server price.
const budgetTierWithEc2 = (): Tier => ({
  name: "budget",
  summary: "single-AZ budget box",
  nodes: [{ id: "api", awsService: "EC2", role: "api host (t4g.small)", security: ["TLS"] }],
  edges: [{ from: "client", to: "api", payload: "JSON request", protocol: "HTTPS" }],
  delta: [],
  tradeoffs: [],
  costDrivers: [
    {
      service: "EC2",
      unit: "$/hr",
      estimateRange: "$12.26–$24.53/mo",
      note: "t4g.small on-demand Linux.",
      instanceType: "t4g.small",
    },
  ],
});

describe("TierTabs instance sizing", () => {
  it("renders the server-priced budget box (~$12), never the old m5.large $70", () => {
    render(
      <TierTabs
        tiers={[budgetTierWithEc2()]}
        assumptions={[]}
        selected="budget"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getAllByText(/~\$12/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/~\$70/).length).toBe(0);
  });

  it("resizing EC2 up to large re-prices the band live (absolute table, not a ratio)", () => {
    render(
      <TierTabs
        tiers={[budgetTierWithEc2()]}
        assumptions={[]}
        selected="budget"
        onSelect={() => undefined}
      />,
    );
    fireEvent.click(screen.getAllByRole("radio", { name: "L" })[0]!);
    // m7g.large / t4g.small ≈ 4.86× of $12.26–$24.53 ⇒ ~$60–$119/mo.
    expect(screen.getAllByText(/~\$60/).length).toBeGreaterThan(0);
  });
});
