import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostSummary } from "./CostSummary.js";
import {
  parseMonthlyRange,
  rollupCost,
  assumedTraffic,
  formatRequests,
  marginalPer10kRequests,
} from "../lib/cost.js";
import type { CostDriver } from "../lib/types.js";

function driver(estimateRange: string): CostDriver {
  return { service: "svc", unit: "u", estimateRange, note: "" };
}

describe("cost rollup (lib/cost)", () => {
  it("parses monthly ranges and ignores per-unit / unparseable strings", () => {
    expect(parseMonthlyRange("$12–$30/mo")).toEqual({ low: 12, high: 30 });
    expect(parseMonthlyRange("$0.20–$0.90/mo")).toEqual({ low: 0.2, high: 0.9 });
    expect(parseMonthlyRange("$1,200 to $2,000/month")).toEqual({ low: 1200, high: 2000 });
    expect(parseMonthlyRange("$0.023/GB-mo")).toBeNull();
    expect(parseMonthlyRange("varies")).toBeNull();
  });

  it("sums the low and high ends across drivers", () => {
    const rollup = rollupCost([driver("$0.20–$0.90/mo"), driver("$12–$30/mo"), driver("$33–$60/mo")]);
    expect(rollup.low).toBeCloseTo(45.2);
    expect(rollup.high).toBeCloseTo(90.9);
    expect(rollup.partial).toBe(false);
    expect(rollup.counted).toBe(3);
  });

  it("flags partial when some drivers can't be summed", () => {
    const rollup = rollupCost([driver("$12–$30/mo"), driver("$0.023/GB-mo")]);
    expect(rollup.counted).toBe(1);
    expect(rollup.partial).toBe(true);
  });

  it("maps each tier to its assumed request volume (per day + per 30-day month)", () => {
    expect(assumedTraffic("budget")).toEqual({ perDay: 1_000, perMonth: 30_000 });
    expect(assumedTraffic("balanced")).toEqual({ perDay: 10_000, perMonth: 300_000 });
    expect(assumedTraffic("resilient")).toEqual({ perDay: 100_000, perMonth: 3_000_000 });
  });

  it("formats request counts compactly", () => {
    expect(formatRequests(1_000)).toBe("1K");
    expect(formatRequests(30_000)).toBe("30K");
    expect(formatRequests(300_000)).toBe("300K");
    expect(formatRequests(3_000_000)).toBe("3M");
  });

  it("marginalPer10kRequests is the variable cost slope over the tier's request band", () => {
    // $0.70–$7.00/mo request-priced driver at balanced: spread $6.30 over the 900k/mo
    // band (90 × 10k/day) ⇒ $6.30 × 10_000 / 900_000 = $0.07 per 10K requests.
    const variable = [driver("$0.70–$7.00/mo")];
    expect(marginalPer10kRequests(variable, "balanced")).toBeCloseTo(0.07, 4);
    // Always-on capacity ($/hr) is excluded — it doesn't grow with request volume.
    const fixed: CostDriver[] = [{ service: "ALB", unit: "$/hr", estimateRange: "$32–$65/mo", note: "" }];
    expect(marginalPer10kRequests(fixed, "balanced")).toBe(0);
  });
});

describe("CostSummary", () => {
  it("renders an estimated monthly band from the drivers", () => {
    render(
      <CostSummary
        drivers={[driver("$0.20–$0.90/mo"), driver("$12–$30/mo"), driver("$33–$60/mo")]}
      />,
    );
    // 45.2 → "45", 90.9 → "91".
    expect(screen.getByText("~$45–$91/mo")).toBeInTheDocument();
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
  });

  it("notes 'partial' when some drivers are unparseable", () => {
    render(<CostSummary drivers={[driver("$12–$30/mo"), driver("$0.023/GB-mo")]} />);
    expect(screen.getByText("~$12–$30/mo")).toBeInTheDocument();
    expect(screen.getByText(/partial/i)).toBeInTheDocument();
  });

  it("renders nothing when no driver has a monthly range", () => {
    const { container } = render(<CostSummary drivers={[driver("$0.023/GB-mo")]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the zero-traffic baseline from fixed (always-on/storage) drivers", () => {
    const withUnit = (estimateRange: string, unit: string): CostDriver => ({
      service: "svc",
      unit,
      estimateRange,
      note: "",
    });
    // A NAT gateway ($/hr) is always-on → counts toward baseline; per-request is variable.
    render(
      <CostSummary
        drivers={[withUnit("$32–$65/mo", "$/hr"), withUnit("$10–$100/mo", "per 1k requests")]}
      />,
    );
    expect(screen.getByText(/\$32\/mo baseline/i)).toBeInTheDocument();
  });

  it("notes scales-to-zero when there are no fixed (always-on) drivers", () => {
    render(
      <CostSummary
        drivers={[{ service: "s", unit: "per 1k requests", estimateRange: "$5–$50/mo", note: "" }]}
      />,
    );
    expect(screen.getByText(/zero traffic/i)).toBeInTheDocument();
    expect(screen.queryByText(/baseline/i)).toBeNull();
  });

  it("shows the tier's assumed traffic and a per-10K marginal tip when given a tierName", () => {
    render(
      <CostSummary
        tierName="balanced"
        drivers={[{ service: "API Gateway", unit: "per 1k requests", estimateRange: "$0.70–$7.00/mo", note: "" }]}
      />,
    );
    expect(screen.getByText(/Assumes ~10K requests\/day \(~300K\/month\)/i)).toBeInTheDocument();
    const band = screen.getByText("~$0.7–$7/mo");
    expect(band.getAttribute("data-tip")).toMatch(/per additional 10K requests/i);
  });

  it("omits the assumed-traffic line and tooltip when no tierName is given", () => {
    render(<CostSummary drivers={[{ service: "s", unit: "per 1k requests", estimateRange: "$5–$50/mo", note: "" }]} />);
    expect(screen.queryByText(/Assumes ~/i)).toBeNull();
    expect(screen.getByText("~$5–$50/mo").getAttribute("data-tip")).toBeNull();
  });
});
