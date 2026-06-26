import { describe, it, expect } from "vitest";
import { graphToMermaid, escapeLabel } from "./mermaid.js";
import type { Node, Edge } from "./types.js";

function node(id: string, awsService: string, role = ""): Node {
  return {
    id,
    awsService,
    role,
    security: [],
  };
}

function edge(from: string, to: string, payload: string, protocol: string): Edge {
  return { from, to, payload, protocol };
}

describe("graphToMermaid (U11 / R4)", () => {
  it("emits a labeled edge for every graph edge", () => {
    const nodes = [node("client", "Client"), node("api", "API Gateway"), node("fn", "Lambda")];
    const edges = [
      edge("client", "api", "JSON request body", "HTTPS"),
      edge("api", "fn", "invoke event", "AWS SDK"),
    ];

    const out = graphToMermaid(nodes, edges);

    expect(out).toContain("flowchart LR");
    // One labeled-edge line per edge.
    const edgeLines = out.split("\n").filter((l) => l.includes("-->"));
    expect(edgeLines).toHaveLength(2);
    expect(out).toContain("JSON request body via HTTPS");
    expect(out).toContain("invoke event via AWS SDK");
    // Every edge label carries "via <protocol>" (R4 — payload+protocol labeled).
    for (const line of edgeLines) {
      expect(line).toMatch(/-->\|".+"\|/);
    }
  });

  it("labels an edge even when protocol or payload is missing", () => {
    const out = graphToMermaid(
      [node("a", "A"), node("b", "B")],
      [edge("a", "b", "", "")],
    );
    const edgeLine = out.split("\n").find((l) => l.includes("-->"))!;
    // Falls back to a non-empty label rather than an unlabeled arrow.
    expect(edgeLine).toMatch(/-->\|"data"\|/);
  });

  it("escapes label text so payloads can't break Mermaid syntax", () => {
    const raw = 'pipe | quote " bracket [x] brace {y} angle <z> hash #';
    const escaped = escapeLabel(raw);
    // None of the raw metacharacters survive.
    expect(escaped).not.toMatch(/[|"[\]{}<>]/);
    expect(escaped).not.toContain(" # ");
    // Replaced with numeric HTML entities.
    expect(escaped).toContain("#124;"); // pipe
    expect(escaped).toContain("#34;"); // quote
    expect(escaped).toContain("#91;"); // [
    expect(escaped).toContain("#35;"); // #
  });

  it("escapes pipes and quotes inside generated edge labels", () => {
    const out = graphToMermaid(
      [node("a", "A"), node("b", "B")],
      [edge("a", "b", 'msg | with "quotes"', "TCP")],
    );
    const edgeLine = out.split("\n").find((l) => l.includes("-->"))!;
    // The only literal quotes/pipes are the Mermaid delimiters, not the payload.
    expect(edgeLine).toContain("#124;");
    expect(edgeLine).toContain("#34;");
    expect(edgeLine).toMatch(/^\s*n0 -->\|".*"\| n1$/);
  });

  it("creates implicit nodes for edge endpoints not present in nodes", () => {
    const out = graphToMermaid([node("api", "API Gateway")], [edge("client", "api", "req", "HTTPS")]);
    // 'client' isn't a declared node but must still appear as a node + edge source.
    expect(out).toContain('["client"]');
    expect(out).toContain('["API Gateway"]');
    expect(out.split("\n").filter((l) => l.includes("-->"))).toHaveLength(1);
  });

  it("enriches the node label with the short role when present", () => {
    const out = graphToMermaid([node("s3", "S3", "thumbnails")], []);
    expect(out).toContain('n0["S3 (thumbnails)"]');
  });

  it("escapes metacharacters inside a node role", () => {
    const out = graphToMermaid([node("s3", "S3", 'evil "role"')], []);
    // The only literal quotes are the Mermaid delimiters, not the role text.
    expect(out).toContain("#34;");
    expect(out).toMatch(/^\s*n0\[".*"\]$/m);
  });

  it("handles an empty graph without error", () => {
    const out = graphToMermaid([], []);
    expect(out).toBe("flowchart LR");
  });

  it("handles a single-node graph without error", () => {
    const out = graphToMermaid([node("only", "S3")], []);
    expect(out).toContain("flowchart LR");
    expect(out).toContain('n0["S3"]');
    expect(out).not.toContain("-->");
  });

  it("respects the requested direction", () => {
    expect(graphToMermaid([], [], "TB")).toBe("flowchart TB");
  });
});
