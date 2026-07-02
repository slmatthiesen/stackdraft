/**
 * SQLite-backed permanent store for every generated design — the gallery + model/
 * template-improvement backbone.
 *
 * One row per distinct (description, answers, round, model, region): `prompt_hash` is
 * UNIQUE and IS the /api/generate response-cache key, which already folds in model +
 * region, so a different model naturally yields a separate row (prior versions kept,
 * never overwritten). Re-running the exact same prompt under the same model upserts —
 * `gen_count` bumps and body/tags refresh, but id, status, votes, terraform, and
 * opt-out are preserved (mirrors the curated store's "replace content, keep signal").
 *
 * Votes reuse the curated pattern: one-per-voter (client IP), a second vote changes
 * the prior rather than stacking, counters recomputed from the votes table inside one
 * transaction so they can't drift. Net downvotes at/below the threshold auto-hide an
 * approved row — community-driven removal without ceding hard-delete.
 */
import { randomBytes } from "node:crypto";

import type {
  GenerationRecord,
  GenerationStats,
  GenerationStatus,
  GenerationSummary,
  GenerationUpsertResult,
  GenerationVoteResult,
  GenerationsStore,
} from "./types.js";
import type { Db, Clock } from "./sqlite.js";
import { systemClock } from "./sqlite.js";
import { aggregateGenerationStats } from "./stats.js";

interface GenRow {
  id: string;
  prompt_hash: string;
  description: string;
  answers_json: string;
  model: string;
  region: string;
  recommended_tier: string;
  tags_json: string;
  body_json: string;
  terraform_json: string | null;
  status: string;
  opt_out: number;
  gen_count: number;
  client_ip: string;
  upvotes: number;
  downvotes: number;
  created_at: number;
  updated_at: number;
}

type SummaryRow = Omit<GenRow, "answers_json" | "body_json" | "terraform_json" | "opt_out">;

/** 12 url-safe chars (~72 bits) — short, shareable deep-link id, collision-safe at scale. */
function newId(): string {
  return randomBytes(9).toString("base64url");
}

function parseStatus(s: string): GenerationStatus {
  return s === "approved" || s === "hidden" ? s : "pending";
}

function toRecord(row: GenRow): GenerationRecord {
  return {
    id: row.id,
    promptHash: row.prompt_hash,
    description: row.description,
    answers: safeParse(row.answers_json, []),
    model: row.model,
    region: row.region,
    recommendedTier: row.recommended_tier,
    tags: safeParse(row.tags_json, []),
    body: row.body_json,
    terraformJson: row.terraform_json,
    status: parseStatus(row.status),
    optOut: row.opt_out === 1,
    genCount: row.gen_count,
    clientIp: row.client_ip,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: SummaryRow): GenerationSummary {
  return {
    id: row.id,
    description: row.description,
    recommendedTier: row.recommended_tier,
    tags: safeParse(row.tags_json, []),
    status: parseStatus(row.status),
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    genCount: row.gen_count,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export class SqliteGenerationsStore implements GenerationsStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async upsert(input: {
    promptHash: string;
    description: string;
    answers: string[];
    model: string;
    region: string;
    recommendedTier: string;
    tags: string[];
    body: string;
    clientIp: string;
  }): Promise<GenerationUpsertResult> {

    const now = this.clock.now();
    // On prompt_hash conflict: refresh content + bump gen_count + touch updated_at,
    // but PRESERVE id, status, opt_out, terraform, votes, created_at (RETURNING yields
    // the surviving id — stable deep link across re-runs of the same prompt).
    const row = this.db
      .prepare(
        `INSERT INTO generations (
            id, prompt_hash, description, answers_json, model, region, recommended_tier,
            tags_json, body_json, terraform_json, status, opt_out, gen_count,
            client_ip, upvotes, downvotes, created_at, updated_at
         )
         VALUES (@id, @promptHash, @description, @answersJson, @model, @region, @recommendedTier,
                 @tagsJson, @bodyJson, NULL, 'pending', 0, 1, @clientIp, 0, 0, @now, @now)
         ON CONFLICT(prompt_hash) DO UPDATE SET
           description = excluded.description,
           answers_json = excluded.answers_json,
           recommended_tier = excluded.recommended_tier,
           tags_json = excluded.tags_json,
           body_json = excluded.body_json,
           gen_count = generations.gen_count + 1,
           updated_at = excluded.updated_at
         RETURNING id, status`,
      )
      .get({
        id: newId(),
        promptHash: input.promptHash,
        description: input.description,
        answersJson: JSON.stringify(input.answers),
        model: input.model,
        region: input.region,
        recommendedTier: input.recommendedTier,
        tagsJson: JSON.stringify(input.tags),
        bodyJson: input.body,
        clientIp: input.clientIp,
        now,
      }) as { id: string; status: string };

    return { id: row.id, status: parseStatus(row.status) };
  }

  async getById(id: string): Promise<GenerationRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM generations WHERE id = ?`).get(id) as
      | GenRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  async getByPromptHash(promptHash: string): Promise<GenerationRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM generations WHERE prompt_hash = ?`).get(promptHash) as
      | GenRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  async listPending(limit: number): Promise<GenerationSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT id, prompt_hash, description, model, region, recommended_tier, tags_json,
                status, gen_count, client_ip, upvotes, downvotes, created_at, updated_at
         FROM generations WHERE status = 'pending'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as SummaryRow[];
    return rows.map(toSummary);
  }

  async listApproved(limit: number): Promise<GenerationSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT id, prompt_hash, description, model, region, recommended_tier, tags_json,
                status, gen_count, client_ip, upvotes, downvotes, created_at, updated_at
         FROM generations WHERE status = 'approved'
         ORDER BY (upvotes - downvotes) DESC, updated_at DESC LIMIT ?`,
      )
      .all(limit) as SummaryRow[];
    return rows.map(toSummary);
  }

  async setStatus(id: string, status: GenerationStatus): Promise<boolean> {
    const res = this.db
      .prepare(`UPDATE generations SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, this.clock.now(), id);
    return res.changes > 0;
  }

  async getTerraform(id: string, tierName: string): Promise<{ code: string } | undefined> {
    const row = this.db
      .prepare(`SELECT terraform_json FROM generations WHERE id = ?`)
      .get(id) as { terraform_json: string | null } | undefined;
    if (!row || !row.terraform_json) return undefined;
    const map = safeParse<Record<string, { code?: string }>>(row.terraform_json, {});
    const entry = map[tierName];
    return entry?.code ? { code: entry.code } : undefined;
  }

  async setTerraform(id: string, tierName: string, code: string): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT terraform_json FROM generations WHERE id = ?`)
      .get(id) as { terraform_json: string | null } | undefined;
    if (!row) return false;
    const map = safeParse<Record<string, { code: string; format: string }>>(row.terraform_json, {});
    map[tierName] = { code, format: "terraform" };
    this.db
      .prepare(`UPDATE generations SET terraform_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(map), this.clock.now(), id);
    return true;
  }

  async vote(id: string, voter: string, value: 1 | -1, hideThreshold: number): Promise<GenerationVoteResult | undefined> {
    const tx = this.db.transaction((): GenerationVoteResult | undefined => {
      const existing = this.db.prepare(`SELECT status FROM generations WHERE id = ?`).get(id) as
        | { status: string }
        | undefined;
      if (!existing) return undefined;

      this.db
        .prepare(
          `INSERT INTO generation_votes (generation_id, voter, value, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(generation_id, voter) DO UPDATE SET value = excluded.value`,
        )
        .run(id, voter, value, this.clock.now());

      // Recompute counters from the votes table so they always match the rows.
      const counts = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS up,
             COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS down
           FROM generation_votes WHERE generation_id = ?`,
        )
        .get(id) as { up: number; down: number };

      // Community-driven removal: an approved design whose net score has soured drops
      // back into the review queue. Hard-delete stays a manual operator action.
      let status = parseStatus(existing.status);
      if (status === "approved" && counts.up - counts.down <= hideThreshold) {
        status = "hidden";
      }
      this.db
        .prepare(`UPDATE generations SET upvotes = ?, downvotes = ?, status = ?, updated_at = ? WHERE id = ?`)
        .run(counts.up, counts.down, status, this.clock.now(), id);

      return { upvotes: counts.up, downvotes: counts.down, status };
    });
    return tx();
  }

  async usageStats(): Promise<GenerationStats> {
    // Project only the three fields stats need (no body/terraform payload) and aggregate
    // in JS via the shared utcDayKey — identical bucketing to the DynamoDB backend, and
    // avoids any SQL ms-vs-s date-unit pitfall.
    const rows = this.db
      .prepare(`SELECT status, created_at, client_ip FROM generations`)
      .all() as Array<{ status: string; created_at: number; client_ip: string }>;
    return aggregateGenerationStats(
      rows.map((r) => ({ status: r.status, createdAtMs: r.created_at, clientIp: r.client_ip })),
    );
  }
}
