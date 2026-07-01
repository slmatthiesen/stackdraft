import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The typed graph the LLM must return (KTD3). The backend renders Mermaid and
 * cost tables deterministically from this — never from free-form model prose.
 *
 * Required fields + types are enforced, but the MODEL-OUTPUT objects below are
 * parsed LENIENTLY (unknown keys stripped, not rejected): LLMs routinely emit
 * extra keys even with `additionalProperties:false` in the sent schema, and a
 * strict parse turned that harmless drift into a hard 502 (seen in the wild as
 * `rationative` for `rationale`, a stray `security` on edges). The fully
 * deterministic result we assemble ourselves (`ArchitectureResultSchema`,
 * `TierSchema`, `CostDriverSchema`) stays strict — those never carry model drift.
 */

export const TIER_NAMES = ["budget", "balanced", "resilient"] as const;
export type TierName = (typeof TIER_NAMES)[number];

// LEANER SHAPE: a node is structure, not prose. `role` is a SHORT label (≤ ~4
// words, e.g. "thumbnail worker") — NOT a sentence explaining what the service
// does — and `security` are short control TAGS (e.g. "TLS", "DLQ", "idempotent
// consumer"). The old prose `purpose` and the `scaling` object are gone: burst
// handling now lives in the tier `delta` and in `security` tags, so the model
// emits differences and structure instead of repeating explanations.
export const NodeSchema = z
  .object({
    id: z.string().describe("Stable node id, referenced by edges."),
    awsService: z.string().describe("AWS service name, e.g. 'API Gateway'."),
    role: z.string().describe("SHORT role label (≤ ~4 words), e.g. 'thumbnail worker' — not prose."),
    security: z
      .array(z.string())
      .describe("Short security-control TAGS (e.g. 'TLS', 'private subnet', 'DLQ', 'idempotent consumer')."),
  });

export const EdgeSchema = z
  .object({
    from: z.string().describe("Source node id (or 'client')."),
    to: z.string().describe("Destination node id."),
    payload: z.string().describe("The data/payload moving across this edge (R4 — every edge labeled)."),
    protocol: z.string().describe("Transport/protocol, e.g. 'HTTPS', 'gRPC', 'SQS'."),
  });

export const CostDriverSchema = z
  .object({
    service: z.string(),
    unit: z
      .string()
      .describe("The service's NATIVE cost unit (R6): 'per 1k requests', '$/GB-month', '$/hr', '$/GB transferred', ..."),
    estimateRange: z.string().describe("A range like '$0.20–$0.90', filled deterministically from PricingStore."),
    note: z.string().describe("Optional clarifying note (e.g. 'required by private-subnet default'). Empty string if none."),
    // The instance class this capacity driver was priced at (e.g. 't4g.small',
    // 'db.r6g.large'), stamped by the cost engine when it resolves an instance-backed
    // $/hr service. PRESENT only on those drivers; the client size-ladder uses it as
    // the absolute-price baseline for a manual re-size (no ratio guessing).
    instanceType: z.string().optional().describe("Instance class priced (e.g. 't4g.small'); set only on instance-backed $/hr drivers."),
  })
  .strict();

// LEANER SHAPE: a tier is STRUCTURE + DIFFERENCES, not exposition. `delta` says
// what THIS tier adds/changes vs the others on the robustness axis (single-AZ →
// multi-AZ, on-demand → provisioned, +read replicas, +DLQ, burst handling); for
// the budget tier it states the baseline. The removed `setupSteps`,
// `burstHandling`, and `securityNotes` were near-redundant prose tiers — the
// security floor is now stated ONCE at the top level (`securityFloor`), and
// resilience/burst reasoning is carried by node `security` tags + `delta`.
export const TierSchema = z
  .object({
    name: z.enum(TIER_NAMES),
    summary: z.string(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    delta: z
      .array(z.string())
      .describe("What THIS tier adds/changes vs the others (robustness incl. burst handling). Budget states the baseline."),
    costDrivers: z.array(CostDriverSchema),
    tradeoffs: z.array(z.string()).describe("Trade-offs versus the other two tiers (R3)."),
  })
  .strict();

/**
 * An ADR-style record of a load-bearing architectural decision: not just WHAT was
 * chosen, but the alternatives weighed and WHY this one wins (trade-offs through
 * the Well-Architected pillars). This is the senior-architect signal — the output
 * commits to a choice and shows the reasoning that makes it trustworthy.
 */
export const KeyDecisionSchema = z
  .object({
    decision: z.string().describe("The architectural question being decided, e.g. 'Compute model for the API tier'."),
    chosen: z.string().describe("The option committed to, e.g. 'Lambda behind API Gateway'."),
    alternativesConsidered: z
      .array(z.string())
      .describe("The viable alternatives weighed and rejected, e.g. ['Fargate', 'EC2 ASG']."),
    rationale: z.string().describe("Why the chosen option wins — the trade-off framed through the WAF pillars."),
  });

// DETERMINISTIC FIELDS — two parts of the result are NO LONGER generated by the
// model; both are reusable knowledge applied AFTER generation, so the LLM output
// schema (`GeneratedArchitectureSchema`) OMITS them and the full downstream type
// (`ArchitectureResultSchema`) adds them back. This is the main cost/speed lever:
// the model stops emitting fixed/recomputable content every request, and that
// content is correct by construction instead of by re-reasoning.
//   - securityFloor: the 8 safe-by-default baselines, injected from `@drafture/kb`.
//   - costDrivers: per-tier $ ranges, computed by `estimateCosts` from the tier's
//     services + the PricingStore (KTD6 — the model is never asked for dollar
//     figures). Dropping ~24-40 cost-driver objects per design also cuts a large
//     slice of output tokens the model was emitting only to have them overwritten.
export const GeneratedTierSchema = z
  .object({
    name: z.enum(TIER_NAMES),
    summary: z.string(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    delta: z
      .array(z.string())
      .describe("What THIS tier adds/changes vs the others (robustness incl. burst handling). Budget states the baseline."),
    tradeoffs: z.array(z.string()).describe("Trade-offs versus the other two tiers (R3)."),
  });

// TIER-DELTA EMISSION — the main output-token lever. Only the BUDGET tier emits a
// full graph; balanced and resilient emit only what CHANGES vs the tier below.
// Measured over real designs: ~43% of nodes and ~50% of edges were re-emitted
// verbatim per tier. `reconstructTiers` rebuilds the three FULL tiers
// deterministically before any downstream step, so cost / properties / web see the
// exact same shape they did when the model emitted three full tiers.
export const EdgeRefSchema = z.object({
  from: z.string().describe("Source node id of the edge to remove."),
  to: z.string().describe("Destination node id of the edge to remove."),
});

export const GeneratedTierDeltaSchema = z.object({
  name: z.enum(TIER_NAMES),
  summary: z.string(),
  addNodes: z
    .array(NodeSchema)
    .describe("Nodes NEW in this tier, OR existing nodes re-stated IN FULL because they changed (upsert by id). Do NOT repeat unchanged nodes."),
  removeNodeIds: z
    .array(z.string())
    .describe("Ids of nodes from the tier below that this tier drops (usually empty — tiers grow upward)."),
  addEdges: z
    .array(EdgeSchema)
    .describe("Edges NEW in this tier, or changed edges re-stated (upsert by from+to). Do NOT repeat unchanged edges."),
  removeEdges: z
    .array(EdgeRefSchema)
    .describe("Edges from the tier below that this tier drops (usually empty)."),
  delta: z
    .array(z.string())
    .describe("What THIS tier adds/changes vs the tier below (one short line each)."),
  tradeoffs: z.array(z.string()).describe("Trade-offs versus the other two tiers."),
});

// Fields shared between the WIRE schema (what the model emits) and the assembled
// RESULT. The two diverge only on how the tiers are represented (deltas vs full).
const commonGeneratedShape = {
  assumptions: z.array(z.string()),
  clarificationsUsed: z.array(z.string()),
  keyDecisions: z
    .array(KeyDecisionSchema)
    .describe("The handful of load-bearing decisions: chosen vs alternatives + why, framed through the WAF pillars."),
} as const;

/** THE WIRE SHAPE the LLM emits: the budget tier in FULL + the other two as DELTAS.
 *  This is what the forced-tool schema constrains. The provider validates against it
 *  then reconstructs to the full `GeneratedArchitecture` — so the wire format is an
 *  internal provider detail and downstream code never sees deltas. */
export const GeneratedWireSchema = z.object({
  ...commonGeneratedShape,
  baseTier: GeneratedTierSchema.describe("The BUDGET tier as a FULL graph — the baseline the other two tiers build on."),
  tierDeltas: z
    .array(GeneratedTierDeltaSchema)
    .length(2)
    .describe("Exactly two: balanced then resilient, EACH as a delta vs the tier below it."),
});

/** LAZY PER-TIER WIRE SHAPE — the BUDGET tier only (the cost/latency default). The
 *  user picks a tier up front (budget by default) and we generate ONLY that one graph
 *  (~⅓ the output of the three-tier emission), adding balanced/resilient on demand via
 *  {@link GeneratedTierDeltaSchema} (see `generate(scope:"budget"|"addTier")`). */
export const GeneratedBudgetWireSchema = z.object({
  ...commonGeneratedShape,
  baseTier: GeneratedTierSchema.describe("The BUDGET tier as a FULL graph — the only tier emitted in the lazy default."),
});
export type GeneratedBudgetWire = z.infer<typeof GeneratedBudgetWireSchema>;

/** What downstream code consumes: three FULL tiers (no security floor yet — injected
 *  later). The provider produces this from the wire shape via `reconstructTiers`. */
export const GeneratedArchitectureSchema = z.object({
  ...commonGeneratedShape,
  // 1..3 since lazy generation: a fresh call returns budget only; the user adds
  // balanced/resilient on demand (each reconstructed as a delta vs the budget baseline).
  tiers: z.array(GeneratedTierSchema).min(1).max(3).describe("One to three tiers (budget always first)."),
});

/** The full result the backend assembles: reconstructed graph + injected security
 *  floor and computed cost drivers. `tiers` is the FULL `TierSchema` (with
 *  costDrivers) since `estimateCosts` fills them deterministically. */
export const ArchitectureResultSchema = z
  .object({
    ...commonGeneratedShape,
    tiers: z
      .array(TierSchema)
      .min(1)
      .max(3)
      .describe("One to three tiers (budget always first), with computed costDrivers — grows as the user adds tiers."),
    // Injected deterministically from the KB — the safe-by-default floor (the 8
    // baselines) stated ONCE, applying to ALL tiers.
    securityFloor: z
      .array(z.string())
      .describe("The safe-by-default floor (the 8 security baselines) stated once; applies to every tier."),
    // Injected deterministically (NOT model-chosen): the tier the UI pre-selects.
    // Always "balanced" (the medium-business default the tiers ladder around) — the
    // model no longer picks a tier, so there's no recommendation prose either.
    recommendedTier: z.enum(TIER_NAMES).describe("Deterministic default-selected tier (always balanced)."),
    recommendationRationale: z
      .string()
      .describe("Retained for response-shape stability; empty now that the recommendation is just the default tier."),
  })
  .strict();

export type ArchitectureNode = z.infer<typeof NodeSchema>;
export type ArchitectureEdge = z.infer<typeof EdgeSchema>;
export type CostDriver = z.infer<typeof CostDriverSchema>;
export type Tier = z.infer<typeof TierSchema>;
export type GeneratedTier = z.infer<typeof GeneratedTierSchema>;
export type GeneratedTierDelta = z.infer<typeof GeneratedTierDeltaSchema>;
export type KeyDecision = z.infer<typeof KeyDecisionSchema>;
export type GeneratedWire = z.infer<typeof GeneratedWireSchema>;
export type GeneratedArchitecture = z.infer<typeof GeneratedArchitectureSchema>;
export type ArchitectureResult = z.infer<typeof ArchitectureResultSchema>;

const edgeKey = (e: { from: string; to: string }): string => `${e.from} ${e.to}`;

/** Apply one tier's delta to the (full) tier below it: drop removed nodes/edges,
 *  then upsert added/changed ones (by node id / by edge endpoints). */
function applyTierDelta(prev: GeneratedTier, d: GeneratedTierDelta): GeneratedTier {
  const removeNode = new Set(d.removeNodeIds);
  const nodes = new Map(prev.nodes.filter((n) => !removeNode.has(n.id)).map((n) => [n.id, n] as const));
  for (const n of d.addNodes) nodes.set(n.id, n); // new id → add; existing id → replace
  const removeEdge = new Set(d.removeEdges.map(edgeKey));
  const edges = new Map(prev.edges.filter((e) => !removeEdge.has(edgeKey(e))).map((e) => [edgeKey(e), e] as const));
  for (const e of d.addEdges) edges.set(edgeKey(e), e);
  // A removed node takes its edges with it. The model routinely lists a node in
  // removeNodeIds (e.g. budget's single box → split into Fargate at balanced) but
  // forgets the edges that touched it, which would reconstruct into a dangling edge.
  // Drop any edge whose endpoint was removed and not re-added — an EXPLICIT removal,
  // so this never masks a typo'd id (those still fail graphHasNoDanglingEdges).
  const droppedByRemoval = (id: string): boolean => removeNode.has(id) && !nodes.has(id);
  const wiredEdges = [...edges.values()].filter((e) => !droppedByRemoval(e.from) && !droppedByRemoval(e.to));
  return {
    name: d.name,
    summary: d.summary,
    nodes: [...nodes.values()],
    edges: wiredEdges,
    delta: d.delta,
    tradeoffs: d.tradeoffs,
  };
}

/** Rebuild three FULL tiers from the budget baseline + the two structured deltas —
 *  the deterministic inverse of the model's delta emission. Pure. Providers call
 *  this so callers always receive the full {@link GeneratedArchitecture}. */
export function reconstructTiers(wire: GeneratedWire): GeneratedArchitecture {
  const tiers: GeneratedTier[] = [wire.baseTier];
  for (const d of wire.tierDeltas) tiers.push(applyTierDelta(tiers[tiers.length - 1]!, d));
  return {
    assumptions: wire.assumptions,
    clarificationsUsed: wire.clarificationsUsed,
    tiers,
    keyDecisions: wire.keyDecisions,
  };
}

/** The lazy default: a single-tier {@link GeneratedArchitecture} carrying ONLY the
 *  budget baseline. The other tiers are added later via {@link reconstructAddedTier}. */
export function reconstructBudgetOnly(wire: GeneratedBudgetWire): GeneratedArchitecture {
  return {
    assumptions: wire.assumptions,
    clarificationsUsed: wire.clarificationsUsed,
    tiers: [wire.baseTier],
    keyDecisions: wire.keyDecisions,
  };
}

/** Reconstruct ONE added tier (balanced or resilient) by applying its delta to the
 *  budget baseline — the on-demand "+ Add tier" path. Same delta arithmetic as the
 *  three-tier reconstruction, but each added tier is expressed vs BUDGET (not vs the
 *  tier below), so tiers can be added in any order without a missing intermediate. */
export function reconstructAddedTier(budgetTier: GeneratedTier, delta: GeneratedTierDelta): GeneratedTier {
  return applyTierDelta(budgetTier, delta);
}

/** The reconstructed graph + injected security floor, BEFORE the deterministic cost
 *  drivers are computed. `generateArchitecture` returns this; `estimateCosts`
 *  fills `costDrivers` on each tier to produce a full {@link ArchitectureResult}. */
export type ArchitectureBeforeCost = GeneratedArchitecture & {
  securityFloor: string[];
  recommendedTier: TierName;
  recommendationRationale: string;
};

/** Clarification gate result (R2). */
export const ClarificationSchema = z
  .object({
    needsClarification: z.boolean(),
    questions: z.array(z.string()).max(3).describe("At most a couple of questions; empty when none needed."),
  });

export type Clarification = z.infer<typeof ClarificationSchema>;

/** JSON Schema for the forced-tool / structured generation. Uses the WIRE schema
 *  (budget full + two deltas, no securityFloor) — the model emits deltas, the floor
 *  is injected and the tiers reconstructed deterministically downstream. */
export function architectureJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(GeneratedWireSchema, {
    name: "GeneratedArchitectureWire",
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

/** JSON Schema for the LAZY budget-only generation tool (baseTier only, no deltas). */
export function budgetArchitectureJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(GeneratedBudgetWireSchema, {
    name: "GeneratedBudgetArchitecture",
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

/** JSON Schema for the on-demand "+ Add tier" tool — one tier as a delta vs budget. */
export function addTierJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(GeneratedTierDeltaSchema, {
    name: "GeneratedTierDelta",
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function clarificationJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ClarificationSchema, {
    name: "Clarification",
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}
