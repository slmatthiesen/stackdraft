import { describe, it, expect } from "vitest";

import { sanitizeGenerated } from "./sanitize.js";
import type { ArchitectureNode, GeneratedArchitecture } from "../schema/architecture.js";

/** Minimal one-tier architecture wrapping the given nodes (sanitizeGenerated
 *  doesn't validate the schema, so a single tier is enough to exercise it). */
function arch(...nodes: ArchitectureNode[]): GeneratedArchitecture {
  return {
    assumptions: [],
    clarificationsUsed: [],
    tiers: [{ name: "budget", summary: "s", nodes, edges: [], delta: [], tradeoffs: [] }],
    keyDecisions: [],
  };
}

/** Read a node's security tags without tripping noUncheckedIndexedAccess. */
function tags(a: GeneratedArchitecture, nodeIndex = 0): string[] {
  return a.tiers[0]?.nodes[nodeIndex]?.security ?? [];
}

describe("sanitizeGenerated", () => {
  it("strips 'private subnet' from managed/serverless services (DynamoDB)", () => {
    const out = sanitizeGenerated(
      arch({ id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["KMS at rest", "private subnet", "least-priv role"] }),
    );
    expect(tags(out)).toEqual(["KMS at rest", "least-priv role"]);
  });

  it("strips from Lambda and S3 too", () => {
    const out = sanitizeGenerated(
      arch(
        { id: "fn", awsService: "Lambda", role: "worker", security: ["least-priv role", "private subnet"] },
        { id: "store", awsService: "S3", role: "object store", security: ["private subnet", "block public access"] },
      ),
    );
    expect(tags(out, 0)).toEqual(["least-priv role"]);
    expect(tags(out, 1)).toEqual(["block public access"]);
  });

  it("keeps 'private subnet' on genuinely VPC-bound services (RDS, ElastiCache)", () => {
    const out = sanitizeGenerated(
      arch(
        { id: "rds", awsService: "RDS", role: "relational datastore", security: ["private subnet", "KMS at rest"] },
        { id: "cache", awsService: "ElastiCache", role: "redis presence", security: ["private subnet"] },
      ),
    );
    expect(tags(out, 0)).toEqual(["private subnet", "KMS at rest"]);
    expect(tags(out, 1)).toEqual(["private subnet"]);
  });

  it("is case-insensitive ('Private Subnet')", () => {
    const out = sanitizeGenerated(
      arch({ id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["Private Subnet"] }),
    );
    expect(tags(out)).toEqual([]);
  });

  it("is a no-op (same reference) when nothing needs stripping", () => {
    const input = arch({ id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["KMS at rest", "least-priv role"] });
    expect(sanitizeGenerated(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = sanitizeGenerated(
      arch({ id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["KMS at rest", "private subnet"] }),
    );
    expect(sanitizeGenerated(once)).toEqual(once);
  });

  it("does not mutate the input", () => {
    const input = arch({ id: "db", awsService: "DynamoDB", role: "primary datastore", security: ["KMS at rest", "private subnet"] });
    sanitizeGenerated(input);
    expect(tags(input)).toEqual(["KMS at rest", "private subnet"]);
  });
});
