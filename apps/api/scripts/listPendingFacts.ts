/**
 * Operator review CLI (U6 / KTD4): list quarantined research facts awaiting
 * verification. Reads the SQLite DB directly and prints every `verified:false`
 * MemoryDoc so the operator can decide what to promote (verify-fact) or drop
 * (verify-fact --reject). No admin surface in V1 — it runs on the host with DB
 * access.
 *
 * DB_PATH is read straight from env (matching the config default) so reviewing
 * facts never requires an ANTHROPIC_API_KEY just to open the database.
 *
 *   pnpm --filter @drafture/api list-pending-facts
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { getDb, createStores } from "../src/store/sqlite.js";
import type { MemoryDoc } from "../src/store/types.js";

const DEFAULT_DB_PATH = "./data/drafture.db";

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatPending(docs: MemoryDoc[]): string {
  if (docs.length === 0) return "No pending (unverified) facts.";
  const lines = docs.map((d) => {
    const seen = new Date(d.createdAt).toISOString();
    return [
      `id:      ${d.id}`,
      `topic:   ${d.topic}`,
      `fact:    ${truncate(d.fact, 80)}`,
      `source:  ${d.source || "(none)"}`,
      `seen:    ${seen}`,
    ].join("\n");
  });
  return [
    `${docs.length} pending (verified:false) fact(s):`,
    "",
    lines.join("\n\n"),
  ].join("\n");
}

function main(): void {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = getDb(dbPath);
  try {
    const { memory } = createStores(db);
    process.stdout.write(`${formatPending(memory.listPending())}\n`);
  } finally {
    db.close();
  }
}

// Only execute when run directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
