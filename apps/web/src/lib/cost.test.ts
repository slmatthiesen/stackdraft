import { describe, it, expect } from "vitest";

import type { CostDriver } from "./types.js";
import { applySizeSelection, parseMonthlyRange } from "./cost.js";

const ec2 = (range = "$70.08–$140.16/mo"): CostDriver => ({
  service: "EC2",
  unit: "$/hr",
  estimateRange: range,
  note: "m5.large on-demand Linux.",
});

const lambda = (): CostDriver => ({
  service: "Lambda",
  unit: "per 1k requests",
  estimateRange: "$0.20–$0.90/mo",
  note: "",
});

describe("applySizeSelection", () => {
  it("scales both endpoints by the selected size's ratio (large = 2x)", () => {
    const out = applySizeSelection([ec2()], { "EC2|$/hr": "l" });
    expect(out[0]!.estimateRange).toBe("$140.16–$280.32/mo");
  });

  it("shrinks the range for the small/budget default", () => {
    const out = applySizeSelection([ec2()], { "EC2|$/hr": "s" });
    expect(out[0]!.estimateRange).toBe("$15.42–$30.84/mo");
  });

  it("medium (ratio 1) is a no-op returning the original driver untouched", () => {
    const d = ec2();
    const out = applySizeSelection([d], { "EC2|$/hr": "m" });
    expect(out[0]).toBe(d);
  });

  it("round-trips: the scaled range re-parses (never silently drops from the rollup)", () => {
    const out = applySizeSelection([ec2()], { "EC2|$/hr": "l" });
    expect(parseMonthlyRange(out[0]!.estimateRange)).toEqual({
      low: 140.16,
      high: 280.32,
    });
  });

  it("passes non-adjustable drivers through unchanged", () => {
    const d = lambda();
    const out = applySizeSelection([d], { "EC2|$/hr": "l" });
    expect(out[0]).toBe(d);
  });

  it("ignores a capacity service whose unit is not $/hr", () => {
    const d: CostDriver = {
      service: "EC2",
      unit: "$/GB transferred",
      estimateRange: "$1–$5/mo",
      note: "",
    };
    expect(applySizeSelection([d], { "EC2|$/GB transferred": "l" })[0]).toBe(d);
  });

  it("leaves an unparseable adjustable range untouched", () => {
    const out = applySizeSelection([ec2("$0.023/GB-mo")], { "EC2|$/hr": "l" });
    expect(out[0]!.estimateRange).toBe("$0.023/GB-mo");
  });

  it("does not mutate the input driver", () => {
    const d = ec2();
    applySizeSelection([d], { "EC2|$/hr": "l" });
    expect(d.estimateRange).toBe("$70.08–$140.16/mo");
  });
});
