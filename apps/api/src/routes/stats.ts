/**
 * GET /api/stats — operator-only product-usage report (the conversion lens).
 *
 * Returns AGGREGATE COUNTS only: generation totals + per-status + per-UTC-day series and
 * a distinct-client-IPs-per-day cardinality, plus feedback thumbs totals + per-day split.
 * Never raw IPs, ids, or prompt text. This is the signal raw pageview analytics can't
 * give — "how many visitors actually generated / added a tier / voted" — and it's already
 * persisted server-side, so it costs $0 and no LLM call to surface.
 *
 * Forker-safe gate: when STATS_TOKEN is unset the route 404s (off, never exposes internal
 * numbers on a bare clone). When set, requests must carry `Authorization: Bearer
 * <STATS_TOKEN>` (or `?token=` for a quick browser visit). The check is constant-time.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppContext } from "../app/context.js";

const ROUTE = "/api/stats";

/** Constant-time token compare (length-guarded — timingSafeEqual throws on length mismatch). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export async function registerStatsRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(ROUTE, async (req, reply) => handleStats(ctx, req, reply));
}

async function handleStats(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const expected = ctx.config.STATS_TOKEN;
  if (!expected) {
    // Off unless configured — never expose internal numbers on a bare clone.
    return reply.code(404).send({ error: "not_found" });
  }
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const queryToken =
    typeof req.query === "object" && req.query ? (req.query as { token?: string }).token : undefined;
  if (!tokenMatches(bearer || queryToken || "", expected)) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  const [generations, feedback] = await Promise.all([
    ctx.stores.generations.usageStats(),
    ctx.stores.feedback.usageStats(),
  ]);
  return reply.code(200).send({ generations, feedback });
}
