/**
 * Pure aggregation for the operator-facing product-usage stats (`/api/stats`).
 * Backend-neutral: both the SQLite and DynamoDB store impls fetch their rows and hand
 * them here, so the UTC-day bucketing (via {@link ./clock.utcDayKey}) is identical on
 * either backend — no SQL date-unit footguns, and the shapes can't drift apart.
 *
 * These return COUNTS ONLY — never raw IPs, prompt text, or ids. The unique-IP figure is
 * a per-day cardinality (size of a Set), which is an aggregate, not personal data.
 */
import { utcDayKey } from "./clock.js";
import type { GenerationStats, FeedbackStats } from "./types.js";

/** One generation row projected to just the fields stats need. */
export interface GenerationStatRow {
  status: string;
  /** Epoch milliseconds (the store clock unit). */
  createdAtMs: number;
  clientIp: string;
}

/** One feedback row projected to just the fields stats need. */
export interface FeedbackStatRow {
  /** 1 = up, -1 = down. */
  rating: number;
  /** Epoch milliseconds (the store clock unit). */
  createdAtMs: number;
}

export function aggregateGenerationStats(rows: GenerationStatRow[]): GenerationStats {
  const stats: GenerationStats = {
    total: rows.length,
    byStatus: { pending: 0, approved: 0, hidden: 0 },
    byDay: {},
    uniqueIpsByDay: {},
  };
  const ipsByDay = new Map<string, Set<string>>();
  for (const r of rows) {
    const day = utcDayKey(r.createdAtMs);
    stats.byDay[day] = (stats.byDay[day] ?? 0) + 1;
    const bucket = r.status === "approved" || r.status === "hidden" ? r.status : "pending";
    stats.byStatus[bucket]++;
    let set = ipsByDay.get(day);
    if (!set) {
      set = new Set();
      ipsByDay.set(day, set);
    }
    set.add(r.clientIp);
  }
  for (const [day, set] of ipsByDay) stats.uniqueIpsByDay[day] = set.size;
  return stats;
}

export function aggregateFeedbackStats(rows: FeedbackStatRow[]): FeedbackStats {
  const stats: FeedbackStats = { total: rows.length, up: 0, down: 0, byDay: {} };
  for (const r of rows) {
    const day = utcDayKey(r.createdAtMs);
    const bucket = stats.byDay[day] ?? { up: 0, down: 0 };
    if (r.rating === 1) {
      stats.up++;
      bucket.up++;
    } else {
      stats.down++;
      bucket.down++;
    }
    stats.byDay[day] = bucket;
  }
  return stats;
}
