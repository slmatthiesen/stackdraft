/**
 * Structural completeness checks (R-completeness) — pure, deterministic, free.
 *
 * Extracted from the golden property suite so the SAME checks gate offline (the
 * eval pass-rate) AND ride the per-generation telemetry line at runtime
 * (`completenessOk`). They matter more since tier-delta emission: balanced/
 * resilient are reconstructed from deltas, so a delta that references a renamed/
 * removed node id would otherwise produce a silently-broken graph. Both are
 * high-confidence (no realistic false positive); `test/golden/properties.ts`
 * imports them so there is one source of truth.
 */
import type { ArchitectureResult } from "../schema/architecture.js";

/** Result shape compatible with the golden suite's `PropertyResult`. */
export interface CompletenessCheck {
  name: "graphHasNoDanglingEdges" | "primaryDatastoreReachable";
  ok: boolean;
  reason: string;
}

// PRIMARY data stores only (OLTP / cache / search) — deliberately EXCLUDES S3,
// which is often a legitimately-unconnected asset/audit-log sink. A primary store
// with no edge is always an incomplete design (you can't read or write it).
const PRIMARY_DATASTORE_KEYWORDS = [
  "dynamodb", "rds", "aurora", "elasticache", "redis", "memcached",
  "opensearch", "elasticsearch", "documentdb", "neptune", "redshift", "timestream",
] as const;

export function isPrimaryDatastore(awsService: string, role: string): boolean {
  const s = `${awsService} ${role}`.toLowerCase();
  return PRIMARY_DATASTORE_KEYWORDS.some((kw) => s.includes(kw));
}

/** Every edge endpoint must be a real node `id` in that tier (or the literal
 *  "client"). A dangling edge is always a bug — and the canonical failure mode of a
 *  bad tier-delta (an addEdge referencing a node id that was renamed or removed). */
export function graphHasNoDanglingEdges(result: ArchitectureResult): CompletenessCheck {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    const ids = new Set(tier.nodes.map((n) => n.id));
    ids.add("client");
    tier.edges.forEach((e, i) => {
      if (!ids.has(e.from)) offenders.push(`${tier.name}:edge[${i}] from unknown '${e.from}'`);
      if (!ids.has(e.to)) offenders.push(`${tier.name}:edge[${i}] to unknown '${e.to}'`);
    });
  }
  return {
    name: "graphHasNoDanglingEdges",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every edge references a real node" : offenders.join("; "),
  };
}

/** A primary datastore (DynamoDB/RDS/Aurora/cache/search) must be touched by at
 *  least one edge — an unwired primary store is an incomplete design. */
export function primaryDatastoreReachable(result: ArchitectureResult): CompletenessCheck {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    const wired = new Set<string>();
    for (const e of tier.edges) {
      wired.add(e.from);
      wired.add(e.to);
    }
    for (const n of tier.nodes) {
      if (isPrimaryDatastore(n.awsService, n.role) && !wired.has(n.id)) {
        offenders.push(`${tier.name}: datastore '${n.id}' (${n.awsService}) has no edge`);
      }
    }
  }
  return {
    name: "primaryDatastoreReachable",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every primary datastore is wired into the graph" : offenders.join("; "),
  };
}

/** True iff a design passes every structural-completeness check — the boolean the
 *  runtime telemetry line reports (`completenessOk`). */
export function isStructurallyComplete(result: ArchitectureResult): boolean {
  return graphHasNoDanglingEdges(result).ok && primaryDatastoreReachable(result).ok;
}
