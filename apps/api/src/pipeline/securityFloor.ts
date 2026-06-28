/**
 * Deterministic security floor (the core deterministic-vs-agentic lever).
 *
 * The safe-by-default floor is reusable knowledge that never varies per request,
 * so the model must NOT generate it — that just re-pays output tokens for a fixed
 * answer and risks drift. Instead we read the curated baselines from the KB
 * (`security-baselines.json`) and surface each baseline's short `summary` line as
 * the global `securityFloor`. Correct by construction, zero model tokens.
 */
import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import type { SecurityBaseline } from "@drafture/kb";

const baselines = securityBaselines as SecurityBaseline[];

/** The fixed safe-by-default floor: one short line per KB baseline. */
export function securityFloorLines(): string[] {
  return baselines.map((b) => b.summary);
}
