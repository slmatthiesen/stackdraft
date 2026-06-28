/**
 * Operator review CLI (U6 / KTD4): promote or reject a quarantined research fact.
 *
 *   pnpm --filter @drafture/api verify-fact <id>            # trust it (verified:true)
 *   pnpm --filter @drafture/api verify-fact --reject <id>   # delete it
 *   pnpm --filter @drafture/api verify-fact <id> --reject   # (either order)
 *
 * Promotion lifts a fact out of the `verified:false` quarantine into the trusted
 * set; rejection removes a sloppy research result so it can't keep grounding
 * recommendations. DB_PATH is read from env (config default) so no API key is
 * needed to run it.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { getDb, createStores } from "../src/store/sqlite.js";

const DEFAULT_DB_PATH = "./data/drafture.db";

interface ParsedArgs {
  id?: string;
  reject: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const reject = argv.includes("--reject");
  const id = argv.find((a) => !a.startsWith("--"));
  return { id, reject };
}

function main(): void {
  const { id, reject } = parseArgs(process.argv.slice(2));
  if (!id) {
    process.stderr.write(
      "Usage: verify-fact <id> [--reject]\n  <id>       promote the fact to verified:true\n  --reject   delete the fact instead\n",
    );
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = getDb(dbPath);
  try {
    const { memory } = createStores(db);
    if (reject) {
      const removed = memory.delete(id);
      if (removed) {
        process.stdout.write(`Rejected and deleted fact ${id}.\n`);
      } else {
        process.stderr.write(`No fact found with id ${id}.\n`);
        process.exit(1);
      }
      return;
    }
    const promoted = memory.setVerified(id, true);
    if (promoted) {
      process.stdout.write(`Verified fact ${id} (now trusted).\n`);
    } else {
      process.stderr.write(`No fact found with id ${id}.\n`);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

// Only execute when run directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
