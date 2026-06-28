/**
 * U11 — PURE structured-graph → Mermaid flowchart conversion (R4).
 *
 * Determinism is the whole point: the diagram is rendered from the typed graph,
 * never round-tripped through the LLM. Every edge is labeled with its payload
 * (and protocol). Unit-tested independently of the `mermaid` renderer.
 */

import type { Node, Edge } from "./types.js";

export type Direction = "LR" | "TB";

/**
 * Escape arbitrary label text so payload/protocol/service strings can't break
 * Mermaid syntax. We wrap labels in double quotes (Mermaid's literal-string
 * form) and replace every metacharacter with its numeric HTML entity so quotes,
 * pipes, brackets, braces and angle brackets are rendered, not parsed. `#` is
 * escaped FIRST so the entities we introduce aren't themselves re-escaped.
 * Newlines collapse to a space to keep each label on one line.
 */
export function escapeLabel(raw: string): string {
  return raw
    .replace(/#/g, "#35;")
    .replace(/"/g, "#34;")
    .replace(/\|/g, "#124;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;")
    .replace(/</g, "#60;")
    .replace(/>/g, "#62;")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** Node label: AWS service, enriched with the short role when present — e.g. "S3 (thumbnails)". */
function nodeLabel(node: Node): string {
  const service = node.awsService || node.id;
  const role = node.role.trim();
  return role ? `${service} (${role})` : service;
}

/** Edge label per R4: "<payload> via <protocol>" (payload alone if no protocol). */
function edgeLabel(edge: Edge): string {
  const payload = edge.payload.trim();
  const protocol = edge.protocol.trim();
  if (payload && protocol) return `${payload} via ${protocol}`;
  if (payload) return payload;
  if (protocol) return `via ${protocol}`;
  return "data"; // never leave an edge unlabeled (R4)
}

/**
 * Observability / notification tail — grouped into its own light-blue panel so
 * the core data path reads separately from the ops/alerting nodes. Matched on
 * AWS service OR role: CloudWatch/X-Ray/PagerDuty/Slack/etc. by service, and
 * alarm/alert/log/trace/monitor/… by role. SNS is intentionally NOT matched by
 * service (it's dual-use) — only its alerting roles trip this.
 */
const OBS_SERVICE = /cloudwatch|x-?ray|pagerduty|slack|teams|cloudtrail/i;
const OBS_ROLE = /alarm|alert|\blog\b|trace|monitor|observ|dashboard|escalat|telemetry|metric|\bslo\b/i;

/**
 * The external caller — the first interaction with the system — tagged `entry` so
 * CSS colors it green. Matched by AWS-service label because the model names it
 * variously ("Client", "External caller", "User", …). Exact-ish labels only, so a
 * core service named "...client..." elsewhere isn't accidentally tinted.
 */
const ENTRY_SERVICE = /^(client|external caller|caller|end ?user|user|third[ -]?party|3rd[ -]?party|customer)$/i;

function isObservabilityNode(awsService: string, role: string): boolean {
  return OBS_SERVICE.test(awsService) || OBS_ROLE.test(role) || OBS_ROLE.test(awsService);
}

/**
 * Convert nodes + edges to a Mermaid `flowchart` string.
 *
 * Node ids from the model are arbitrary strings (and edges may reference
 * endpoints — e.g. 'client' — that aren't in `nodes`). We map every distinct id
 * to a safe synthetic id (`n0`, `n1`, …) so node ids never need escaping, and
 * carry the human label (awsService, or the raw id for implicit endpoints) in a
 * quoted, escaped label. Empty and single-node graphs are handled without error.
 *
 * Two visual cues (styled via CSS in DiagramView's containers):
 *  - the external `client` node — the first interaction with the system — is
 *    tagged `entry` so it can be colored green;
 *  - observability/notification nodes are wrapped in a `subgraph` so they sit in
 *    their own panel, distinct from the core data path.
 */
export function graphToMermaid(
  nodes: Node[],
  edges: Edge[],
  direction: Direction = "LR",
): string {
  const labelById = new Map<string, string>();
  const metaById = new Map<string, { awsService: string; role: string }>();
  const order: string[] = [];

  const register = (id: string, label: string, meta: { awsService: string; role: string }): void => {
    if (!labelById.has(id)) {
      labelById.set(id, label);
      metaById.set(id, meta);
      order.push(id);
    }
  };

  for (const node of nodes) {
    register(node.id, nodeLabel(node), { awsService: node.awsService, role: node.role });
  }
  // Edge endpoints not declared as nodes become implicit nodes labeled by id.
  for (const edge of edges) {
    register(edge.from, edge.from, { awsService: edge.from, role: "" });
    register(edge.to, edge.to, { awsService: edge.to, role: "" });
  }

  // Anchor the external caller (client) at the top: declare entry nodes first so
  // dagre renders them at the top of the TB flow. They're graph roots (no incoming
  // edges); declaration order settles the tie within rank 0.
  order.sort((a, b) => {
    const rank = (id: string): number =>
      ENTRY_SERVICE.test((metaById.get(id)?.awsService ?? "").trim()) ? 0 : 1;
    return rank(a) - rank(b);
  });

  const safeId = new Map<string, string>();
  order.forEach((id, i) => safeId.set(id, `n${i}`));

  const isObs = (id: string): boolean => {
    const m = metaById.get(id);
    return !!m && isObservabilityNode(m.awsService, m.role);
  };
  const obsIds = order.filter(isObs);
  const otherIds = order.filter((id) => !isObs(id));

  const lines: string[] = [`flowchart ${direction}`];

  // Observability/notification nodes grouped in their own subgraph panel.
  if (obsIds.length > 0) {
    lines.push(`  subgraph obs ["Observability & notifications"]`);
    for (const id of obsIds) {
      lines.push(`    ${safeId.get(id)!}["${escapeLabel(labelById.get(id) ?? id)}"]`);
    }
    lines.push(`  end`);
  }

  for (const id of otherIds) {
    lines.push(`  ${safeId.get(id)!}["${escapeLabel(labelById.get(id) ?? id)}"]`);
  }

  for (const edge of edges) {
    const from = safeId.get(edge.from)!;
    const to = safeId.get(edge.to)!;
    lines.push(`  ${from} -->|"${escapeLabel(edgeLabel(edge))}"| ${to}`);
  }

  // Tag the external caller (the first interaction with the system) so CSS can
  // color it green. classDef is a self-contained fallback; CSS wins for theming.
  const entryIds = order.filter((id) =>
    ENTRY_SERVICE.test((metaById.get(id)?.awsService ?? "").trim()),
  );
  if (entryIds.length > 0) {
    lines.push(`  classDef entry fill:#e8f3d6,stroke:#46601f,stroke-width:1.5px`);
    lines.push(`  class ${entryIds.map((id) => safeId.get(id)!).join(",")} entry`);
  }

  // Color the observability subgraph's panel (native Mermaid styling — reliable
  // regardless of the rendered SVG's DOM; the .cluster CSS rule is a backup).
  if (obsIds.length > 0) {
    lines.push(`  style obs fill:#e3f2fd,stroke:#90caf9,stroke-width:1px`);
  }

  return lines.join("\n");
}
