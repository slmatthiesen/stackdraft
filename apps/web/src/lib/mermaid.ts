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
 * Convert nodes + edges to a Mermaid `flowchart` string.
 *
 * Node ids from the model are arbitrary strings (and edges may reference
 * endpoints — e.g. 'client' — that aren't in `nodes`). We map every distinct id
 * to a safe synthetic id (`n0`, `n1`, …) so node ids never need escaping, and
 * carry the human label (awsService, or the raw id for implicit endpoints) in a
 * quoted, escaped label. Empty and single-node graphs are handled without error.
 */
export function graphToMermaid(
  nodes: Node[],
  edges: Edge[],
  direction: Direction = "LR",
): string {
  const labelById = new Map<string, string>();
  const order: string[] = [];

  const register = (id: string, label: string): void => {
    if (!labelById.has(id)) {
      labelById.set(id, label);
      order.push(id);
    }
  };

  for (const node of nodes) register(node.id, nodeLabel(node));
  // Edge endpoints not declared as nodes become implicit nodes labeled by id.
  for (const edge of edges) {
    register(edge.from, edge.from);
    register(edge.to, edge.to);
  }

  const safeId = new Map<string, string>();
  order.forEach((id, i) => safeId.set(id, `n${i}`));

  const lines: string[] = [`flowchart ${direction}`];

  for (const id of order) {
    const sid = safeId.get(id)!;
    lines.push(`  ${sid}["${escapeLabel(labelById.get(id) ?? id)}"]`);
  }

  for (const edge of edges) {
    const from = safeId.get(edge.from)!;
    const to = safeId.get(edge.to)!;
    lines.push(`  ${from} -->|"${escapeLabel(edgeLabel(edge))}"| ${to}`);
  }

  return lines.join("\n");
}
