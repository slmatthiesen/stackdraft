/**
 * SQLite backing for the four storage interfaces (KTD5). One file, WAL mode,
 * idempotent CREATE TABLE IF NOT EXISTS migrations on boot. A Redis impl can
 * later drop in behind the same interfaces without touching callers.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { SqliteMemoryStore } from "./memory.js";
import { SqliteResponseCache } from "./responseCache.js";
import { SqlitePricingStore } from "./pricing.js";
import { SqliteSpendLedger } from "./spendLedger.js";
import { SqliteCuratedStore } from "./curated.js";
import { SqliteFeedbackStore } from "./feedback.js";
import { SqliteGenerationsStore } from "./generations.js";
import { SqliteDesignVectorStore } from "./designVectors.js";

/** Instance type of an open better-sqlite3 database. */
export type Db = Database.Database;

/**
 * Injectable clock so day-boundary and TTL behavior is testable without waiting
 * on real time. The UTC day key is always derived from `now()` (single knob).
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** UTC calendar day bucket (YYYY-MM-DD) used for spend + per-IP daily counts. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS memory_docs (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    fact TEXT NOT NULL,
    rationale TEXT NOT NULL,
    source TEXT NOT NULL,
    verified INTEGER NOT NULL,
    provenance TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_topic ON memory_docs(topic);
  CREATE INDEX IF NOT EXISTS idx_memory_verified ON memory_docs(verified);

  CREATE TABLE IF NOT EXISTS response_cache (
    prompt_hash TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pricing (
    service TEXT NOT NULL,
    region TEXT NOT NULL,
    unit TEXT NOT NULL,
    usd REAL NOT NULL,
    month TEXT NOT NULL,
    note TEXT NOT NULL,
    PRIMARY KEY (service, region, unit, month)
  );
  CREATE INDEX IF NOT EXISTS idx_pricing_sr ON pricing(service, region);

  CREATE TABLE IF NOT EXISTS spend_entries (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_entries(day);

  CREATE TABLE IF NOT EXISTS ip_counts (
    ip TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (ip, day)
  );

  CREATE TABLE IF NOT EXISTS curated_runs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    body TEXT NOT NULL,
    upvotes INTEGER NOT NULL DEFAULT 0,
    downvotes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS curated_votes (
    run_id TEXT NOT NULL REFERENCES curated_runs(id) ON DELETE CASCADE,
    voter TEXT NOT NULL,
    value INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, voter)
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    prompt_hash TEXT NOT NULL,
    description TEXT NOT NULL,
    answers_json TEXT,
    round INTEGER NOT NULL,
    recommended_tier TEXT NOT NULL,
    body_json TEXT,
    rating INTEGER NOT NULL,
    ip TEXT NOT NULL,
    comment TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(ip, prompt_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);

  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    prompt_hash TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    model TEXT NOT NULL,
    region TEXT NOT NULL,
    recommended_tier TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    body_json TEXT NOT NULL,
    terraform_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    opt_out INTEGER NOT NULL DEFAULT 0,
    gen_count INTEGER NOT NULL DEFAULT 1,
    client_ip TEXT NOT NULL,
    upvotes INTEGER NOT NULL DEFAULT 0,
    downvotes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
  CREATE INDEX IF NOT EXISTS idx_generations_updated ON generations(updated_at);

  CREATE TABLE IF NOT EXISTS generation_votes (
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    voter TEXT NOT NULL,
    value INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (generation_id, voter)
  );

  CREATE TABLE IF NOT EXISTS design_embeddings (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    text TEXT NOT NULL,
    vector BLOB NOT NULL,
    dim INTEGER NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_design_embeddings_model ON design_embeddings(model);
`;

/** Open (creating parent dirs as needed), enable WAL, and migrate. */
export function getDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Wait rather than immediately throwing SQLITE_BUSY when another connection
  // holds the write lock (matters once a refresh job shares the file).
  db.pragma("busy_timeout = 5000");
  db.exec(MIGRATIONS);
  // Idempotent column adds for tables CREATE TABLE IF NOT EXISTS can't extend.
  // curated_runs gained a tags column so the gallery facets curated + user-generated
  // designs uniformly (backfilled by the retag script).
  addColumnIfMissing(db, "curated_runs", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  return db;
}

/** Add a column to a table only if it is absent (idempotent ALTER for migrations). */
function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

/** Fresh isolated in-memory DB for tests (no file, nothing to clean up). */
export function openTempDb(): Db {
  return getDb(":memory:");
}

/** A unique temp-file path for tests that exercise the real on-disk path. */
export function tempDbPath(): string {
  return join(tmpdir(), `drafture-test-${randomUUID()}.db`);
}

export interface Stores {
  memory: SqliteMemoryStore;
  responseCache: SqliteResponseCache;
  pricing: SqlitePricingStore;
  spendLedger: SqliteSpendLedger;
  curated: SqliteCuratedStore;
  feedback: SqliteFeedbackStore;
  generations: SqliteGenerationsStore;
  designVectors: SqliteDesignVectorStore;
}

/** Construct all stores bound to one db instance (shared clock). */
export function createStores(db: Db, clock: Clock = systemClock): Stores {
  return {
    memory: new SqliteMemoryStore(db, clock),
    responseCache: new SqliteResponseCache(db, clock),
    pricing: new SqlitePricingStore(db),
    spendLedger: new SqliteSpendLedger(db, clock),
    curated: new SqliteCuratedStore(db, clock),
    feedback: new SqliteFeedbackStore(db, clock),
    generations: new SqliteGenerationsStore(db, clock),
    designVectors: new SqliteDesignVectorStore(db, clock),
  };
}
