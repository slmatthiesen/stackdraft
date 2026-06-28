import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { seedKnowledgeBase } from "../store/kbLoader.js";
import type {
  ArchitectureNode,
  ArchitectureResult,
  Tier,
} from "../schema/architecture.js";

import {
  estimateCosts,
  formatRange,
  onDemandDisclaimer,
  ASSUMED_MONTHLY_VOLUME,
  TIER_COST_MULTIPLIER,
  TIER_VOLUME_SCALE,
} from "./cost.js";

const REGION = "us-east-1";

function node(awsService: string, over: Partial<ArchitectureNode> = {}): ArchitectureNode {
  return {
    id: awsService.toLowerCase().replace(/\s+/g, "-"),
    awsService,
    role: `${awsService} node`,
    security: ["TLS", "least-privilege role"],
    ...over,
  };
}

function tier(name: Tier["name"], nodes: ArchitectureNode[], delta: string[]): Tier {
  return {
    name,
    summary: `${name} tier`,
    nodes,
    edges: [],
    // LLM placeholder cost drivers — the estimator fills these deterministically.
    costDrivers: [{ service: "placeholder", unit: "?", estimateRange: "?", note: "" }],
    delta,
    tradeoffs: ["vs other"],
  };
}

// The global security floor mandates a private data tier (no public data tier);
// combined with a tier's RDS/ElastiCache/EC2 service it forces the NAT/egress cost.
const SECURITY_FLOOR = [
  "Encryption at rest with KMS / SSE.",
  "TLS in transit; HTTPS only.",
  "Least-privilege IAM, no long-lived keys.",
  "S3 Block Public Access on.",
  "Data tier in private subnets, no public route.",
  "Secrets in AWS Secrets Manager.",
  "Edge protection: CloudFront + WAF.",
  "CloudTrail + access logging.",
];

// A container tier whose data tier (RDS) sits in a private subnet → NAT/egress
// cost is forced (R6/R7 #5). A serverless tier with no private subnet → no NAT.
const RECOMMENDATION: Pick<
  ArchitectureResult,
  "recommendedTier" | "recommendationRationale" | "keyDecisions"
> = {
  recommendedTier: "balanced",
  recommendationRationale: "Balanced fits the assumed ~1M req/mo with multi-AZ availability.",
  keyDecisions: [
    {
      decision: "Compute model",
      chosen: "Fargate behind an ALB",
      alternativesConsidered: ["Lambda", "EC2 ASG"],
      rationale: "Long-running, steady CPU work suits containers over per-request billing.",
    },
  ],
};

function result(): ArchitectureResult {
  return {
    assumptions: ["assumes ~1M requests/month"],
    clarificationsUsed: [],
    securityFloor: SECURITY_FLOOR,
    ...RECOMMENDATION,
    tiers: [
      // Balanced trips the NAT/egress cost via its RDS data tier + the floor's
      // private-subnet mandate (no private-subnet tag needed on the node).
      tier(
        "balanced",
        [node("ALB"), node("Fargate"), node("RDS"), node("CloudFront"), node("WAF")],
        ["+ multi-AZ RDS", "+ read replica"],
      ),
      // Budget is serverless (Lambda + DynamoDB, no VPC) — no private data service,
      // no private-subnet signal → no NAT/egress line.
      tier(
        "budget",
        [node("Lambda"), node("API Gateway"), node("DynamoDB"), node("S3")],
        ["baseline: serverless, no VPC, no NAT required"],
      ),
    ],
  };
}

describe("estimateCosts", () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores); // loads the offline pricing seed into the store
  });

  it("maps a private-subnet tier to native-unit ranges incl. a NAT/egress line (R6)", () => {
    const out = estimateCosts(result(), stores.pricing, REGION);
    const balanced = out.tiers[0]!;

    // Every driver is a range string in $/mo form.
    for (const d of balanced.costDrivers) {
      expect(d.estimateRange).toMatch(/^\$[\d.]+–\$[\d.]+\/mo$/);
    }

    // ALB ($/hr) range = cached price × band × the BALANCED tier capacity
    // multiplier (always-on capacity scales with tier redundancy; no drift).
    const albPrice = stores.pricing.get("ALB", REGION).find((r) => r.unit === "hour")!;
    const band = ASSUMED_MONTHLY_VOLUME["hour"]!;
    const mult = TIER_COST_MULTIPLIER.balanced;
    const albDriver = balanced.costDrivers.find((d) => d.service === "ALB" && d.unit === "$/hr")!;
    expect(albDriver.estimateRange).toBe(
      formatRange(albPrice.usd * band.low * mult, albPrice.usd * band.high * mult),
    );

    // The forced NAT-gateway line is present, in its native units, and flagged.
    const natProcessed = balanced.costDrivers.find(
      (d) => d.service === "NAT Gateway" && d.unit === "$/GB processed",
    );
    expect(natProcessed).toBeDefined();
    expect(natProcessed!.note).toMatch(/private-subnet security default/i);

    const natHour = balanced.costDrivers.find((d) => d.service === "NAT Gateway" && d.unit === "$/hr");
    expect(natHour).toBeDefined();

    // The internet-egress data-transfer line is present and flagged.
    const egress = balanced.costDrivers.find(
      (d) => d.service === "Data Transfer" && d.unit === "$/GB internet egress",
    );
    expect(egress).toBeDefined();
    expect(egress!.note).toMatch(/private-subnet security default/i);
  });

  it("scales cost by tier (resilient > balanced > budget)", () => {
    // Same service (ALB) in all three tiers — the difference is each tier's volume
    // stage (TIER_VOLUME_SCALE) × its robustness multiplier (TIER_COST_MULTIPLIER),
    // so the range must grow budget→balanced→resilient.
    const sameNodes = [node("ALB")];
    const differentiated: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier("budget", sameNodes, ["baseline: single-AZ"]),
        tier("balanced", sameNodes, ["+ multi-AZ"]),
        tier("resilient", sameNodes, ["+ multi-AZ + read replicas"]),
      ],
    };

    const out = estimateCosts(differentiated, stores.pricing, REGION);
    const albPrice = stores.pricing.get("ALB", REGION).find((r) => r.unit === "hour")!;
    const band = ASSUMED_MONTHLY_VOLUME["hour"]!;
    const albRange = (t: Tier): string =>
      t.costDrivers.find((d) => d.service === "ALB" && d.unit === "$/hr")!.estimateRange;

    const [budget, balanced, resilient] = out.tiers as [Tier, Tier, Tier];
    // ALB is always-on CAPACITY: its $/hr band is NOT scaled by the request-volume
    // ladder (TIER_VOLUME_SCALE) — only by the per-tier robustness multiplier, so the
    // three tiers differ by topology (1×/2×/3×), not by 0.1×/1×/10× request volume.
    const expected = (t: Tier["name"]): string => {
      const mult = TIER_COST_MULTIPLIER[t];
      return formatRange(albPrice.usd * band.low * mult, albPrice.usd * band.high * mult);
    };
    expect(albRange(budget)).toBe(expected("budget"));
    expect(albRange(balanced)).toBe(expected("balanced"));
    expect(albRange(resilient)).toBe(expected("resilient"));
    // ALB is not a VPC-bound datastore and no node tags "private subnet" → no NAT line.
    expect(budget.costDrivers.some((d) => d.service === "NAT Gateway")).toBe(false);
  });

  it("surfaces the NAT/egress line on EVERY VPC-bound tier (Aurora/Fargate), not just one", () => {
    // The old narrow {RDS,ElastiCache,EC2} check missed Aurora/Fargate, so the NAT
    // line appeared inconsistently across tiers. Both VPC-bound tiers must trip it.
    const vpcTiers: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier("balanced", [node("ALB"), node("Fargate"), node("Aurora")], ["+ multi-AZ Aurora"]),
        tier("resilient", [node("ALB"), node("Fargate"), node("Aurora")], ["+ Aurora read replicas"]),
      ],
    };

    const out = estimateCosts(vpcTiers, stores.pricing, REGION);
    for (const t of out.tiers) {
      expect(t.costDrivers.some((d) => d.service === "NAT Gateway")).toBe(true);
      expect(t.costDrivers.some((d) => d.service === "Data Transfer")).toBe(true);
    }
  });

  it("does NOT add a NAT/egress line for a tier with no private subnet", () => {
    const out = estimateCosts(result(), stores.pricing, REGION);
    const budget = out.tiers[1]!;
    expect(budget.costDrivers.some((d) => d.service === "NAT Gateway")).toBe(false);
    expect(budget.costDrivers.some((d) => d.service === "Data Transfer")).toBe(false);

    // Lambda carries BOTH native units (per-1k requests + $/GB-second).
    const units = budget.costDrivers.filter((d) => d.service === "Lambda").map((d) => d.unit);
    expect(units).toContain("per 1k requests");
    expect(units).toContain("$/GB-second");
  });

  it("does NOT add a NAT line when a non-VPC node merely contains a VPC substring (e.g. 'dashboaRDS')", () => {
    // Regression: a bare substring match on "rds" mis-fired on "CloudWatch
    // Dashboards" (and "records"), adding a phantom NAT line to pure-serverless
    // tiers. Word-boundary matching must reject it.
    const serverlessWithDashboards: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier(
          "balanced",
          [node("Lambda"), node("DynamoDB"), node("CloudWatch Dashboards")],
          ["+ dashboards"],
        ),
      ],
    };

    const out = estimateCosts(serverlessWithDashboards, stores.pricing, REGION);
    const balanced = out.tiers[0]!;
    expect(balanced.costDrivers.some((d) => d.service === "NAT Gateway")).toBe(false);
    expect(balanced.costDrivers.some((d) => d.service === "Data Transfer")).toBe(false);
  });

  it("splits a combined service label ('A + B') so each service is priced, not dropped", () => {
    // The model groups services in one node ("CloudFront + WAF", "ALB / RDS");
    // without splitting, the whole label misses a price match and BOTH cost lines
    // vanish from the tier. Each part must be priced independently.
    const combined: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [tier("balanced", [node("ALB + RDS")], ["+ multi-AZ"])],
    };

    const out = estimateCosts(combined, stores.pricing, REGION);
    const services = out.tiers[0]!.costDrivers.map((d) => d.service);
    expect(services).toContain("ALB");
    expect(services).toContain("RDS");
  });

  it("prices delivery/event services the model now emits (SES, EventBridge)", () => {
    // The notification pipeline directs the model to SES for email and EventBridge
    // for the resilient-tier bus; both must be priced, or a billable notification
    // system's primary variable cost (email delivery) is silently omitted.
    const withDelivery: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [tier("balanced", [node("SES"), node("EventBridge")], ["+ event bus + email delivery"])],
    };

    const out = estimateCosts(withDelivery, stores.pricing, REGION);
    const services = out.tiers[0]!.costDrivers.map((d) => d.service);
    expect(services).toContain("SES");
    expect(services).toContain("EventBridge");
  });

  it("prices data/observability services the model emits (Aurora, OpenSearch, Kinesis, CloudWatch Logs, X-Ray)", () => {
    // These were silently $0 (no seed entry) — and Aurora/OpenSearch even TRIGGERED
    // a NAT line while their own compute showed $0. Each must now carry its own cost.
    const withData: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier(
          "balanced",
          [node("Aurora"), node("OpenSearch"), node("Kinesis"), node("CloudWatch Logs"), node("X-Ray")],
          ["+ data + observability"],
        ),
      ],
    };

    const out = estimateCosts(withData, stores.pricing, REGION);
    const services = out.tiers[0]!.costDrivers.map((d) => d.service);
    for (const s of ["Aurora", "OpenSearch", "Kinesis", "CloudWatch Logs", "X-Ray"]) {
      expect(services).toContain(s);
    }
  });

  it("prices API Gateway WebSocket API (connection-minutes + messages), not silently dropped", () => {
    // The model emits 'API Gateway WebSocket APIs' for realtime/chat workloads; it
    // must normalize to the priced 'API Gateway WebSocket' (connection-minutes +
    // messages) instead of missing a REST-only 'API Gateway' match and billing $0.
    const withWs: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [tier("balanced", [node("API Gateway WebSocket APIs"), node("Lambda")], ["+ websocket"])],
    };
    const out = estimateCosts(withWs, stores.pricing, REGION);
    const drivers = out.tiers[0]!.costDrivers;
    expect(drivers.some((d) => d.service === "API Gateway WebSocket" && d.unit === "$/M connection-min")).toBe(true);
    expect(drivers.some((d) => d.service === "API Gateway WebSocket" && d.unit === "per 1k requests")).toBe(true);
  });

  it("costs each tier at its own volume stage (budget 0.1× → balanced 1× → resilient 30×)", () => {
    // Volume is intrinsic to the tier ladder, not an intake knob: the SAME service in
    // each tier is priced at that tier's stage × its robustness multiplier.
    const sameNodes = [node("API Gateway")];
    const ladder: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier("budget", sameNodes, ["baseline"]),
        tier("balanced", sameNodes, ["+ multi-AZ"]),
        tier("resilient", sameNodes, ["+ cross-region"]),
      ],
    };
    const price = stores.pricing.get("API Gateway", REGION).find((r) => r.unit === "per-1k-requests")!;
    const band = ASSUMED_MONTHLY_VOLUME["per-1k-requests"]!;
    const out = estimateCosts(ladder, stores.pricing, REGION);
    const reqRange = (t: Tier): string =>
      t.costDrivers.find((d) => d.service === "API Gateway" && d.unit === "per 1k requests")!.estimateRange;
    for (const t of out.tiers as Tier[]) {
      const vol = TIER_VOLUME_SCALE[t.name];
      const mult = TIER_COST_MULTIPLIER[t.name];
      expect(reqRange(t)).toBe(
        formatRange(price.usd * (band.low * vol) * mult, price.usd * (band.high * vol) * mult),
      );
    }
  });

  it("falls back to the seed and flags approximate when the cache lacks a service", () => {
    // Hand-seeded store with ONLY Lambda — DynamoDB/API Gateway are missing.
    const empty = createStores(openTempDb());
    empty.pricing.replaceMonth(REGION, "2026-06", [
      { service: "Lambda", region: REGION, unit: "per-1k-requests", usd: 0.0002, month: "2026-06", note: "cached" },
    ]);

    const serverless: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier("budget", [node("Lambda"), node("DynamoDB")], ["baseline: serverless, no VPC, no NAT"]),
      ],
    };

    const out = estimateCosts(serverless, empty.pricing, REGION);
    const drivers = out.tiers[0]!.costDrivers;

    const lambda = drivers.find((d) => d.service === "Lambda")!;
    expect(lambda.note).not.toMatch(/approximate/i); // cached, exact

    const dynamo = drivers.filter((d) => d.service === "DynamoDB");
    expect(dynamo.length).toBeGreaterThan(0);
    for (const d of dynamo) {
      expect(d.note).toMatch(/^approximate/i); // seed fallback flagged
    }
  });

  it("attaches the on-demand-list-price disclaimer to assumptions (R6)", () => {
    const out = estimateCosts(result(), stores.pricing, REGION);
    expect(out.assumptions).toContain(onDemandDisclaimer(REGION));
    const disclaimer = out.assumptions.find((a) => a.includes("on-demand list prices"))!;
    expect(disclaimer).toMatch(/Free Tier/);
    expect(disclaimer).toMatch(/Savings Plans|Reserved/);

    // Idempotent: re-running does not duplicate the disclaimer.
    const twice = estimateCosts(out, stores.pricing, REGION);
    expect(twice.assumptions.filter((a) => a === onDemandDisclaimer(REGION))).toHaveLength(1);
  });
});
