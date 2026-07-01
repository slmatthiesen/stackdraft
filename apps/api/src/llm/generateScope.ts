/**
 * Generation SCOPE — the lazy-per-tier lever (docs/plans/2026-06-30-007, fix A).
 *
 * `generate()` used to always emit three tiers (budget full + two deltas). That is
 * the bulk of the output tokens and latency. A scope lets a caller emit LESS:
 *   - `budget`  — ONLY the budget tier (the cost/latency DEFAULT, ~⅓ the output).
 *   - `addTier` — ONE tier (balanced/resilient) as a delta vs the budget baseline,
 *                 generated on demand when the user clicks "+ Add tier".
 *   - `full`    — the original three-tier emission (kept for evals / the stress test).
 *
 * This module is the single place that maps a scope to (tool name, tool JSON schema,
 * wire zod schema, the extra user-turn content, and the reconstruct fn), so both the
 * Claude and GLM providers branch identically with no duplicated wiring.
 */
import type { z } from "zod";

import {
  GeneratedBudgetWireSchema,
  GeneratedTierDeltaSchema,
  GeneratedWireSchema,
  reconstructAddedTier,
  reconstructBudgetOnly,
  reconstructTiers,
  type GeneratedArchitecture,
  type GeneratedTier,
  type TierName,
} from "../schema/architecture.js";
import { addTierToolSchema, architectureToolSchema, budgetArchitectureToolSchema } from "./schema-utils.js";

export type GenerateScope =
  | { kind: "full" }
  | { kind: "budget" }
  | { kind: "addTier"; budgetTier: GeneratedTier; target: TierName };

export interface ResolvedScope {
  toolName: string;
  toolDescription: string;
  /** JSON Schema sent as the tool `input_schema` / function `parameters`. */
  toolSchema: Record<string, unknown>;
  /** Zod schema the tool output is re-validated against (defense in depth). */
  wireSchema: z.ZodTypeAny;
  /** Extra user-turn content appended after the grounded suffix (the addTier baseline). */
  extraUserContent?: string;
  /** Turn the validated wire object into a full (1–3 tier) GeneratedArchitecture. */
  reconstruct(wire: unknown): GeneratedArchitecture;
}

export function resolveGenerateScope(scope: GenerateScope = { kind: "full" }): ResolvedScope {
  switch (scope.kind) {
    case "budget":
      return {
        toolName: "emit_budget_architecture",
        toolDescription: "Emit ONLY the budget tier of the AWS design as one structured object (no other tiers).",
        toolSchema: budgetArchitectureToolSchema(),
        wireSchema: GeneratedBudgetWireSchema,
        reconstruct: (wire) => reconstructBudgetOnly(wire as never),
      };
    case "addTier": {
      const target = scope.target;
      const budgetTier = scope.budgetTier;
      return {
        toolName: "emit_tier",
        toolDescription: `Emit ONLY the ${target} tier as a single delta vs the provided budget baseline.`,
        toolSchema: addTierToolSchema(),
        wireSchema: GeneratedTierDeltaSchema,
        extraUserContent: buildAddTierInstruction(budgetTier, target),
        reconstruct: (wire) => {
          // Force the delta's tier name to the requested target so a mis-named delta
          // still reconstructs into the tier the user asked for.
          const delta = { ...(wire as Record<string, unknown>), name: target } as never;
          return {
            assumptions: [],
            clarificationsUsed: [],
            keyDecisions: [],
            tiers: [reconstructAddedTier(budgetTier, delta)],
          };
        },
      };
    }
    case "full":
    default:
      return {
        toolName: "emit_architecture",
        toolDescription: "Emit the three-tier AWS architecture design as one structured object.",
        toolSchema: architectureToolSchema(),
        wireSchema: GeneratedWireSchema,
        reconstruct: (wire) => reconstructTiers(wire as never),
      };
  }
}

/** The budget baseline + the "emit a single delta vs this" instruction, appended to the
 *  user turn for an addTier call so the model expresses the tier as a small change. */
function buildAddTierInstruction(budgetTier: GeneratedTier, target: TierName): string {
  const baseline = {
    nodes: budgetTier.nodes.map((n) => ({ id: n.id, awsService: n.awsService, role: n.role, security: n.security })),
    edges: budgetTier.edges.map((e) => ({ from: e.from, to: e.to, payload: e.payload, protocol: e.protocol })),
  };
  return [
    `## Add the ${target.toUpperCase()} tier — emit it as a DELTA vs the BUDGET baseline below`,
    `Build ONLY the ${target} tier by expressing what CHANGES vs this budget baseline on the ROBUSTNESS axis`,
    `(${target === "resilient" ? "multi-region / DR, read replicas, cross-region failover" : "multi-AZ, managed split (ALB/Fargate/RDS), WAF + customer CMK + Secrets Manager"}).`,
    `Reuse the SAME node ids so inheritance works. Emit a SINGLE delta object: addNodes (new OR changed nodes,`,
    `re-stated in full with the same id), removeNodeIds, addEdges, removeEdges, plus this tier's summary, delta`,
    `(one short line each), and tradeoffs. Do NOT repeat unchanged nodes/edges — they are inherited.`,
    ``,
    `BUDGET BASELINE:`,
    JSON.stringify(baseline, null, 2),
  ].join("\n");
}
