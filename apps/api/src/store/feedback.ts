/**
 * SQLite-backed store for thumbs-up/down feedback on generated designs.
 *
 * One verdict per (client IP, design): the table's UNIQUE(ip, prompt_hash) constraint
 * means a second vote from the same IP on the same design UPDATES the prior rating via
 * UPSERT (never stacks) — so a user re-clicking thumbs changes their verdict rather than
 * ballot-stuffing. IP is the only identity available for an anonymous public tool, the
 * same assumption the rate limiter makes.
 *
 * The rated output's body is snapshotted into the row so the operator review script is
 * self-contained and survives the 24h response_cache TTL.
 */
import { randomUUID } from "node:crypto";

import type { FeedbackEntry, FeedbackStats, FeedbackStore } from "./types.js";
import type { Db, Clock } from "./sqlite.js";
import { systemClock } from "./sqlite.js";
import { aggregateFeedbackStats } from "./stats.js";

interface FeedbackRow {
  id: string;
  prompt_hash: string;
  description: string;
  answers_json: string | null;
  round: number;
  recommended_tier: string;
  body_json: string | null;
  rating: number;
  ip: string;
  comment: string | null;
  created_at: number;
  updated_at: number;
}

export class SqliteFeedbackStore implements FeedbackStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async upsert(entry: Omit<FeedbackEntry, "id" | "createdAt" | "updatedAt">): Promise<FeedbackEntry> {
    const id = randomUUID();
    const now = this.clock.now();
    const answersJson = entry.answers.length > 0 ? JSON.stringify(entry.answers) : null;
    // RETURNING gives the canonical (post-conflict) row, so id/createdAt are correct on
    // both insert and the update-on-conflict path — no separate read-back needed.
    const row = this.db
      .prepare(
        `INSERT INTO feedback
           (id, prompt_hash, description, answers_json, round, recommended_tier,
            body_json, rating, ip, comment, created_at, updated_at)
         VALUES
           (@id, @promptHash, @description, @answersJson, @round, @recommendedTier,
            @bodyJson, @rating, @ip, @comment, @now, @now)
         ON CONFLICT(ip, prompt_hash) DO UPDATE SET
           rating          = excluded.rating,
           recommended_tier = excluded.recommended_tier,
           body_json       = excluded.body_json,
           comment         = excluded.comment,
           updated_at      = excluded.updated_at
         RETURNING *`,
      )
      .get({
        id,
        promptHash: entry.promptHash,
        description: entry.description,
        answersJson,
        round: entry.round,
        recommendedTier: entry.recommendedTier,
        bodyJson: entry.body,
        rating: entry.rating,
        ip: entry.ip,
        comment: entry.comment,
        now,
      }) as FeedbackRow;
    return toEntry(row);
  }

  async listByRating(rating: 1 | -1, limit: number): Promise<FeedbackEntry[]> {
    const rows = this.db
      .prepare(`SELECT * FROM feedback WHERE rating = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(rating, limit) as FeedbackRow[];
    return rows.map(toEntry);
  }

  async usageStats(): Promise<FeedbackStats> {
    const rows = this.db
      .prepare(`SELECT rating, created_at FROM feedback`)
      .all() as Array<{ rating: number; created_at: number }>;
    return aggregateFeedbackStats(rows.map((r) => ({ rating: r.rating, createdAtMs: r.created_at })));
  }
}

function toEntry(row: FeedbackRow): FeedbackEntry {
  return {
    id: row.id,
    promptHash: row.prompt_hash,
    description: row.description,
    answers: row.answers_json ? (JSON.parse(row.answers_json) as string[]) : [],
    round: row.round,
    recommendedTier: row.recommended_tier,
    body: row.body_json,
    rating: row.rating as 1 | -1,
    ip: row.ip,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
