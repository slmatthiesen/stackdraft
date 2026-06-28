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
  trafficVolumeScale,
  ASSUMED_MONTHLY_VOLUME,
  TIER_COST_MULTIPLIER,
} from "./cost.js";
import instancePrices from "@drafture/kb/instance-prices.seed.json" with { type: "json" };

const REGION = "us-east-1";
const PRICE = (t: string): number => (instancePrices as { prices: Record<string, number> }).prices[t]!;

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

  it("does NOT add a NAT line for a VPC service explicitly tagged public-subnet (single-instance budget)", () => {
    // The documented budget shape: a single public-IP EC2/ECS box with direct egress
    // and NO NAT gateway. A node tagged "public subnet"/"no outbound NAT" must opt OUT
    // of the forced NAT line — otherwise the cost engine fabricates a $33/mo gateway the
    // design explicitly says it doesn't have.
    const publicBox: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [
        tier(
          "budget",
          [
            node("ECS on EC2", {
              role: "API server (t4g.small)",
              security: ["public subnet, tight SG: 443 from CF only", "no outbound NAT needed (direct egress)"],
            }),
            node("S3"),
          ],
          ["baseline: single public-subnet box, direct egress, no NAT, no ALB"],
        ),
      ],
    };
    const out = estimateCosts(publicBox, stores.pricing, REGION);
    expect(out.tiers[0]!.costDrivers.some((d) => d.service === "NAT Gateway")).toBe(false);
  });

  it("STILL adds a NAT line for a VPC service in a private subnet (no public-subnet tag)", () => {
    // Guard the opt-out doesn't over-fire: a normal private-subnet EC2/Fargate box
    // (no public-subnet tag) must keep its NAT line.
    const privateBox: ArchitectureResult = {
      assumptions: [],
      clarificationsUsed: [],
      securityFloor: SECURITY_FLOOR,
      ...RECOMMENDATION,
      tiers: [tier("balanced", [node("Fargate"), node("RDS")], ["+ multi-AZ"])],
    };
    const out = estimateCosts(privateBox, stores.pricing, REGION);
    expect(out.tiers[0]!.costDrivers.some((d) => d.service === "NAT Gateway")).toBe(true);
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

  it("prices a REQUEST line IDENTICALLY across tiers — traffic is shared, robustness doesn't touch requests", () => {
    // Traffic is its own axis now (reversed the tier-as-scale-ladder): all three tiers
    // are costed at the SAME volume, so a request-priced line is identical across them.
    // The robustness multiplier must NOT apply on top (that double-count made a
    // resilient SES line read 30× instead of the shared volume).
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
    const out = estimateCosts(ladder, stores.pricing, REGION); // default <50k band → volumeScale 1
    const reqRange = (t: Tier): string =>
      t.costDrivers.find((d) => d.service === "API Gateway" && d.unit === "per 1k requests")!.estimateRange;
    const expected = formatRange(price.usd * band.low, price.usd * band.high);
    for (const t of out.tiers as Tier[]) expect(reqRange(t)).toBe(expected);
  });

  it("scales the SHARED request volume by the traffic answer (its own axis), same across tiers", () => {
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
    const out = estimateCosts(ladder, stores.pricing, REGION, 10); // <500k band
    const reqRange = (t: Tier): string =>
      t.costDrivers.find((d) => d.service === "API Gateway" && d.unit === "per 1k requests")!.estimateRange;
    const expected = formatRange(price.usd * band.low * 10, price.usd * band.high * 10);
    for (const t of out.tiers as Tier[]) expect(reqRange(t)).toBe(expected);
  });

  it("scales a CAPACITY line by the robustness multiplier across tiers — NOT volume", () => {
    // An always-on capacity line (ALB, $/hr) is traffic-independent: it does not move
    // with the request-volume stage. It scales across tiers via the robustness
    // multiplier (1×/2×/3×) — the redundancy premium (extra AZs/replicas) is what
    // actually costs more. This is the mirror of the request-line rule above.
    const sameNodes = [node("ALB")];
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
    const price = stores.pricing.get("ALB", REGION).find((r) => r.unit === "hour")!;
    const band = ASSUMED_MONTHLY_VOLUME["hour"]!;
    const out = estimateCosts(ladder, stores.pricing, REGION);
    const hourRange = (t: Tier): string =>
      t.costDrivers.find((d) => d.service === "ALB" && d.unit === "$/hr")!.estimateRange;
    for (const t of out.tiers as Tier[]) {
      const mult = TIER_COST_MULTIPLIER[t.name];
      expect(hourRange(t)).toBe(formatRange(price.usd * band.low * mult, price.usd * band.high * mult));
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

describe("normalizeService keyword fallback (GAP 3)", () => {
  let stores: Stores;
  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores);
  });

  // Descriptive model labels that don't exact-match the seed must still price
  // (previously silently $0). Returns the priced service names for a one-node tier.
  const driversFor = (awsService: string): string[] => {
    const base = result();
    base.tiers = [tier("balanced", [node(awsService)], [])];
    return estimateCosts(base, stores.pricing, REGION).tiers[0]!.costDrivers.map(
      (d) => d.service,
    );
  };

  it.each([
    ["ECS Fargate task", "Fargate"],
    ["Aurora Serverless v2 (Postgres)", "Aurora"],
    ["SNS topic", "SNS"],
    ["SQS queue", "SQS"],
    ["EventBridge Scheduler", "EventBridge"],
    ["ElastiCache for Redis", "ElastiCache"],
    ["OpenSearch Service", "OpenSearch"],
    ["EBS volume (gp3)", "EBS"],
  ])("prices %s as %s, not silently $0", (label, canonical) => {
    expect(driversFor(label)).toContain(canonical);
  });

  // ECS launch type drives the bill. An ECS-on-EC2 task is priced as the EC2 instance;
  // "Fargate-compatible" on it is a task-def portability note, NOT a launch type, and
  // must not price phantom Fargate (the real-dollar bug on the self-host budget tier).
  it("prices 'ECS on EC2' as EC2, not $0", () => {
    expect(driversFor("ECS on EC2")).toContain("EC2");
  });

  it("does NOT price a Fargate-compatible EC2 task as Fargate", () => {
    const priced = driversFor("ECS Task (Fargate-compatible definition)");
    expect(priced).not.toContain("Fargate");
  });
});

describe("instance sizing (Fix 1 — honor architect's size, else tier default)", () => {
  let stores: Stores;
  beforeEach(() => {
    stores = createStores(openTempDb());
    seedKnowledgeBase(stores);
  });

  const one = (name: Tier["name"], n: ArchitectureNode): ArchitectureResult => ({
    assumptions: [],
    clarificationsUsed: [],
    securityFloor: SECURITY_FLOOR,
    ...RECOMMENDATION,
    tiers: [tier(name, [n], ["baseline"])],
  });

  const ec2Hour = (out: ArchitectureResult): { estimateRange: string; instanceType?: string } =>
    out.tiers[0]!.costDrivers.find((d) => d.service === "EC2" && d.unit === "$/hr")!;

  it("THE MISSING INVARIANT: priced size MATCHES the size the architect stated (t4g.small, not m5.large $70)", () => {
    // The self-host bug: node says "API host (t4g.small)" but the engine billed m5.large.
    const out = estimateCosts(one("balanced", node("EC2", { role: "API host (t4g.small)" })), stores.pricing, REGION);
    const ec2 = ec2Hour(out);
    expect(ec2.instanceType).toBe("t4g.small");
    const band = ASSUMED_MONTHLY_VOLUME["hour"]!;
    const mult = TIER_COST_MULTIPLIER.balanced;
    expect(ec2.estimateRange).toBe(formatRange(PRICE("t4g.small") * band.low * mult, PRICE("t4g.small") * band.high * mult));
  });

  it("parses a db.* class for a relational store (db.r6g.large), not the default", () => {
    const out = estimateCosts(one("balanced", node("RDS", { role: "Postgres (db.r6g.large)" })), stores.pricing, REGION);
    const rds = out.tiers[0]!.costDrivers.find((d) => d.service === "RDS" && d.unit === "$/hr")!;
    expect(rds.instanceType).toBe("db.r6g.large");
  });

  it("falls back to the TIER DEFAULT when the architect states no size — budget→small (never m5.large)", () => {
    const out = estimateCosts(one("budget", node("EC2")), stores.pricing, REGION); // bare "EC2"
    const ec2 = ec2Hour(out);
    expect(ec2.instanceType).toBe("t4g.small"); // budget default, NOT m5.large
    expect(ec2.instanceType).not.toBe("m5.large");
  });

  it("THE CHEAP PATH (GAP-1 closed): a budget EC2 box prices ~$12/mo, not ~$70 (m5.large)", () => {
    const out = estimateCosts(one("budget", node("EC2")), stores.pricing, REGION);
    const ec2 = ec2Hour(out);
    const low = Number(/\$([\d.]+)–/.exec(ec2.estimateRange)![1]);
    expect(low).toBeGreaterThan(10);
    expect(low).toBeLessThan(20); // ~$12.26 (t4g.small × 730 hr), nowhere near $70
  });

  it("the tier DEFAULT ladders by tier (budget small < balanced < resilient large) when no size stated", () => {
    const lowOf = (name: Tier["name"]): number => {
      const out = estimateCosts(one(name, node("EC2")), stores.pricing, REGION);
      return Number(/\$([\d.]+)–/.exec(ec2Hour(out).estimateRange)![1]);
    };
    expect(lowOf("budget")).toBeLessThan(lowOf("balanced"));
    expect(lowOf("balanced")).toBeLessThan(lowOf("resilient"));
  });

  it("DOUBLE-APPLY GUARD: stamps instanceType on the instance line so the client re-prices off the same table (not a tier ratio); non-instance $/hr lines carry none", () => {
    const out = estimateCosts(
      { ...one("balanced", node("EC2", { role: "API host (t4g.small)" })) },
      stores.pricing,
      REGION,
    );
    const ec2 = ec2Hour(out);
    expect(ec2.instanceType).toBe("t4g.small"); // server tells the client what it priced
    // ALB / NAT $/hr are not sized instances → no instanceType (client must not resize them).
    const albOut = estimateCosts(one("balanced", node("ALB")), stores.pricing, REGION);
    const alb = albOut.tiers[0]!.costDrivers.find((d) => d.service === "ALB" && d.unit === "$/hr")!;
    expect(alb.instanceType).toBeUndefined();
  });
});

describe("traffic as its own axis (Problem 2)", () => {
  it("trafficVolumeScale parses the intake answer; absent/empty → the sensible default band", () => {
    expect(trafficVolumeScale(["Expected monthly visitors: < 1k"])).toBe(0.1);
    expect(trafficVolumeScale(["Expected monthly visitors: < 50k"])).toBe(1);
    expect(trafficVolumeScale(["Expected monthly visitors: < 500k"])).toBe(10);
    expect(trafficVolumeScale(["Expected monthly visitors: Millions"])).toBe(100);
    expect(trafficVolumeScale(["Downtime tolerance: Mission-critical"])).toBe(1); // unrelated answer
    expect(trafficVolumeScale([])).toBe(1);
    expect(trafficVolumeScale(undefined)).toBe(1);
  });

  it("states the assumed traffic in assumptions so a skipped traffic question stays honest", () => {
    const stores = createStores(openTempDb());
    seedKnowledgeBase(stores);
    const out = estimateCosts(
      {
        assumptions: [],
        clarificationsUsed: [],
        securityFloor: SECURITY_FLOOR,
        ...RECOMMENDATION,
        tiers: [tier("balanced", [node("Lambda")], ["baseline"])],
      },
      stores.pricing,
      REGION,
    );
    expect(out.assumptions.some((a) => /assumed traffic/i.test(a))).toBe(true);
  });
});
