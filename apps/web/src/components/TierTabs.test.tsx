import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TierTabs } from "./TierTabs.js";
import type { Tier } from "../lib/types.js";

// A budget tier whose only adjustable driver is an EC2 $/hr box at the seed's
// medium price ($70.08–$140.16/mo). Per-tier default for budget is SMALL (0.22x),
// so a correct render shows the cheap band, not the medium one.
const budgetTierWithEc2 = (): Tier => ({
  name: "budget",
  summary: "single-AZ budget box",
  nodes: [{ id: "api", awsService: "EC2", role: "api host", security: ["TLS"] }],
  edges: [{ from: "client", to: "api", payload: "JSON request", protocol: "HTTPS" }],
  delta: [],
  tradeoffs: [],
  costDrivers: [
    {
      service: "EC2",
      unit: "$/hr",
      estimateRange: "$70.08–$140.16/mo",
      note: "m5.large on-demand Linux.",
    },
  ],
});

describe("TierTabs instance-size defaults", () => {
  it("Budget defaults EC2 to small, so the band shows the cheap box (not medium)", () => {
    render(
      <TierTabs
        tiers={[budgetTierWithEc2()]}
        assumptions={[]}
        selected="budget"
        onSelect={() => undefined}
      />,
    );
    // Small (0.22x) of $70–$140 ≈ $15–$31; the medium $70–$140 band must be gone.
    expect(screen.getAllByText(/~\$15/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/~\$70/).length).toBe(0);
  });

  it("resizing EC2 to large re-prices the band live", () => {
    render(
      <TierTabs
        tiers={[budgetTierWithEc2()]}
        assumptions={[]}
        selected="budget"
        onSelect={() => undefined}
      />,
    );
    fireEvent.click(screen.getAllByRole("radio", { name: "L" })[0]!);
    // Large (2x) of $70–$140 ≈ $140–$280.
    expect(screen.getAllByText(/~\$140/).length).toBeGreaterThan(0);
  });
});
