import { describe, it, expect } from "vitest";

import type { CostDriver } from "./types.js";
import { applySizeSelection, formatRange, parseMonthlyRange } from "./cost.js";
import { INSTANCE_PRICES } from "./sizeLadder.js";

// A SERVER-PRICED budget EC2 box: the engine resolved t4g.small and stamped the
// driver, so the range already reflects that class (no client ratio needed).
const ec2 = (over: Partial<CostDriver> = {}): CostDriver => ({
  service: "EC2",
  unit: "$/hr",
  estimateRange: "$12.26–$24.53/mo",
  note: "t4g.small on-demand Linux.",
  instanceType: "t4g.small",
  ...over,
});

const lambda = (): CostDriver => ({
  service: "Lambda",
  unit: "per 1k requests",
  estimateRange: "$0.20–$0.90/mo",
  note: "",
});

/** Re-price `d` to `pickedType` using the SAME absolute table the impl uses. */
function expectedRange(d: CostDriver, baseType: string, pickedType: string): string {
  const { low, high } = parseMonthlyRange(d.estimateRange)!;
  const ratio = INSTANCE_PRICES[pickedType]! / INSTANCE_PRICES[baseType]!;
  return formatRange(low * ratio, high * ratio);
}

describe("applySizeSelection (absolute-price re-size, no ratios)", () => {
  it("re-prices an explicit pick off the absolute table relative to the server's class", () => {
    // Pick L (m7g.large) on a box the server priced at t4g.small.
    const out = applySizeSelection([ec2()], { "EC2|$/hr": "l" });
    expect(out[0]!.estimateRange).toBe(expectedRange(ec2(), "t4g.small", "m7g.large"));
  });

  it("NO selection is a no-op — the server price stands (no auto-seeded default ratio)", () => {
    const d = ec2();
    const out = applySizeSelection([d], {});
    expect(out[0]).toBe(d); // same object, byte-identical range — kills the double-apply
  });

  it("picking the server's OWN class (S = t4g.small here) is a no-op (ratio 1)", () => {
    const d = ec2();
    const out = applySizeSelection([d], { "EC2|$/hr": "s" });
    expect(out[0]).toBe(d);
  });

  it("shrinks when picking a smaller class than the server priced", () => {
    // Server priced t4g.large (M); pick S (t4g.small) → cheaper.
    const d = ec2({ estimateRange: "$49–$98/mo", instanceType: "t4g.large", note: "t4g.large" });
    const out = applySizeSelection([d], { "EC2|$/hr": "s" });
    expect(out[0]!.estimateRange).toBe(expectedRange(d, "t4g.large", "t4g.small"));
    expect(parseMonthlyRange(out[0]!.estimateRange)!.low).toBeLessThan(49);
  });

  it("round-trips: the re-priced range re-parses (never silently drops from the rollup)", () => {
    const out = applySizeSelection([ec2()], { "EC2|$/hr": "l" });
    expect(parseMonthlyRange(out[0]!.estimateRange)).not.toBeNull();
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
    const out = applySizeSelection([ec2({ estimateRange: "$0.023/GB-mo" })], { "EC2|$/hr": "l" });
    expect(out[0]!.estimateRange).toBe("$0.023/GB-mo");
  });

  it("does not mutate the input driver", () => {
    const d = ec2();
    applySizeSelection([d], { "EC2|$/hr": "l" });
    expect(d.estimateRange).toBe("$12.26–$24.53/mo");
  });
});
