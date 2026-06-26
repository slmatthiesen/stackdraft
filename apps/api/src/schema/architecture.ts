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

export const NodeSchema = z
  .object({
    id: z.string().describe("Stable node id, referenced by edges."),
    awsService: z.string().describe("AWS service name, e.g. 'API Gateway'."),
    purpose: z.string().describe("What this node does in the design."),
    security: z
      .array(z.string())
      .describe("Security controls applied to this node (TLS, WAF, least-priv role, ...)."),
    scaling: z
      .object({
        burst: z.string().describe("How this node absorbs burst load."),
        trivialInCore: z
          .boolean()
          .describe("True if burst handling is built into the core (trivial add), false if it is an option."),
      })
      .strict(),
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

export const TierSchema = z
  .object({
    name: z.enum(TIER_NAMES),
    summary: z.string(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    setupSteps: z.array(z.string()).describe("Ordered, plain-language setup instructions (R5)."),
    costDrivers: z.array(CostDriverSchema),
    burstHandling: z
      .array(z.string())
      .describe("Burst notes — 'built-in: ...' when trivial, 'optional: ...' otherwise (R8)."),
    securityNotes: z.array(z.string()).describe("Non-empty: the safe-by-default posture applied to this tier (R7)."),
    tradeoffs: z.array(z.string()).describe("Trade-offs versus the other two tiers (R3)."),
  })
  .strict();

export const ArchitectureResultSchema = z
  .object({
    assumptions: z.array(z.string()),
    clarificationsUsed: z.array(z.string()),
    tiers: z.array(TierSchema).length(3).describe("Exactly three tiers: budget, balanced, resilient."),
  })
  .strict();

export type ArchitectureNode = z.infer<typeof NodeSchema>;
export type ArchitectureEdge = z.infer<typeof EdgeSchema>;
export type CostDriver = z.infer<typeof CostDriverSchema>;
export type Tier = z.infer<typeof TierSchema>;
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
