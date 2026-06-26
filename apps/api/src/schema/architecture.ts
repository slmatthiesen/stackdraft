import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The typed graph the LLM must return (KTD3). The backend renders Mermaid and
 * cost tables deterministically from this — never from free-form model prose.
 *
 * Every field is required and objects are closed (`additionalProperties:false`)
 * to satisfy Anthropic structured-output constraints; the JSON Schema emitted by
 * {@link architectureJsonSchema} is what gets passed to `output_config.format`.
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
  })
  .strict();

export const EdgeSchema = z
  .object({
    from: z.string().describe("Source node id (or 'client')."),
    to: z.string().describe("Destination node id."),
    payload: z.string().describe("The data/payload moving across this edge (R4 — every edge labeled)."),
    protocol: z.string().describe("Transport/protocol, e.g. 'HTTPS', 'gRPC', 'SQS'."),
  })
  .strict();

export const CostDriverSchema = z
  .object({
    service: z.string(),
    unit: z
      .string()
      .describe("The service's NATIVE cost unit (R6): 'per 1k requests', '$/GB-month', '$/hr', '$/GB transferred', ..."),
    estimateRange: z.string().describe("A range like '$0.20–$0.90', filled deterministically from PricingStore."),
    note: z.string().describe("Optional clarifying note (e.g. 'required by private-subnet default'). Empty string if none."),
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
  })
  .strict();

export const ArchitectureResultSchema = z
  .object({
    assumptions: z.array(z.string()),
    clarificationsUsed: z.array(z.string()),
    // LEANER SHAPE: the safe-by-default floor (the 8 baselines) stated ONCE here,
    // applying to ALL tiers — instead of repeating the whole security posture in
    // every tier's prose. Short lines, one per baseline.
    securityFloor: z
      .array(z.string())
      .describe("The safe-by-default floor (the 8 security baselines) stated once; applies to every tier."),
    tiers: z.array(TierSchema).length(3).describe("Exactly three tiers: budget, balanced, resilient."),
    recommendedTier: z
      .enum(TIER_NAMES)
      .describe("The single tier to actually ship for THIS workload — the opinionated recommendation."),
    recommendationRationale: z
      .string()
      .describe("1–2 sentences justifying why that tier fits this specific problem (traffic, availability, compliance)."),
    keyDecisions: z
      .array(KeyDecisionSchema)
      .describe("The handful of load-bearing decisions: chosen vs alternatives + why, framed through the WAF pillars."),
  })
  .strict();

export type ArchitectureNode = z.infer<typeof NodeSchema>;
export type ArchitectureEdge = z.infer<typeof EdgeSchema>;
export type CostDriver = z.infer<typeof CostDriverSchema>;
export type Tier = z.infer<typeof TierSchema>;
export type KeyDecision = z.infer<typeof KeyDecisionSchema>;
export type ArchitectureResult = z.infer<typeof ArchitectureResultSchema>;

/** Clarification gate result (R2). */
export const ClarificationSchema = z
  .object({
    needsClarification: z.boolean(),
    questions: z.array(z.string()).max(3).describe("At most a couple of questions; empty when none needed."),
  })
  .strict();

export type Clarification = z.infer<typeof ClarificationSchema>;

/** JSON Schema for `output_config.format` (structured generation). */
export function architectureJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ArchitectureResultSchema, {
    name: "ArchitectureResult",
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
