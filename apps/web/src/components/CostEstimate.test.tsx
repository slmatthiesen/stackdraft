import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CostEstimate } from "./CostEstimate.js";
import type { CostDriver } from "../lib/types.js";

const drivers: CostDriver[] = [
  { service: "Lambda", unit: "per 1k requests", estimateRange: "$0.20–$0.90/mo", note: "" },
  { service: "RDS", unit: "$/hr", estimateRange: "$12–$25/mo", note: "" },
  {
    service: "NAT Gateway",
    unit: "$/hr",
    estimateRange: "$33–$60/mo",
    note: "required by private-subnet default",
  },
  { service: "S3", unit: "$/GB-month", estimateRange: "$1–$3/mo", note: "" },
];
const assumptions = ["Prices are AWS on-demand list prices for us-east-1."];

describe("CostEstimate", () => {
  it("leads with the band + top drivers and tucks the full table behind show-all", () => {
    render(<CostEstimate drivers={drivers} assumptions={assumptions} />);

    // Summed monthly band (46.2 → 88.9).
    expect(screen.getByText(/~\$\d+–\$\d+\/mo/)).toBeInTheDocument();
    // The costliest driver leads the summary list (and also exists in the table).
    expect(screen.getAllByText("NAT Gateway").length).toBeGreaterThanOrEqual(1);
    // Full table is collapsed behind a disclosure.
    expect(screen.getByText(/show all 4 cost drivers/i)).toBeInTheDocument();
  });

  it("renders the heading even with no drivers", () => {
    render(<CostEstimate drivers={[]} assumptions={[]} />);
    expect(screen.getByText("Cost estimate")).toBeInTheDocument();
    expect(screen.queryByText(/show all/i)).not.toBeInTheDocument();
  });

  it("shows an S/M/L selector for adjustable services and fires onSizeChange", () => {
    const onSizeChange = vi.fn();
    render(
      <CostEstimate
        drivers={drivers}
        assumptions={assumptions}
        sizeSelection={{ "RDS|$/hr": "m" }}
        onSizeChange={onSizeChange}
      />,
    );

    // RDS is in the ladder → its selector renders.
    const rdsGroups = screen.getAllByRole("radiogroup", { name: "RDS instance size" });
    expect(rdsGroups.length).toBeGreaterThanOrEqual(1);

    // NAT Gateway is $/hr but NOT in the ladder → no selector.
    expect(
      screen.queryByRole("radiogroup", { name: "NAT Gateway instance size" }),
    ).toBeNull();

    // Picking "L" reports the driver key + size to the parent.
    fireEvent.click(within(rdsGroups[0]!).getByRole("radio", { name: "L" }));
    expect(onSizeChange).toHaveBeenCalledWith("RDS|$/hr", "l");
  });
});
