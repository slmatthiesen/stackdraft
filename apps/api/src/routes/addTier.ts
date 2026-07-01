/**
 * POST /api/generate/tier — the "+ Add tier" endpoint (docs/plans/2026-06-30-007, fix A).
 *
 * A fresh /api/generate now returns ONLY the budget tier (the cost/latency default).
 * When the user wants balanced or resilient, the client posts the already-generated
 * BUDGET tier here as the baseline and we generate JUST that one tier as a delta vs it
 * (~⅓ the tokens of the old three-tier build), price it, and hand back the single
 * costed tier for the UI to append. Cached per (prompt, tier) so a re-add is free, and
 * merged into the persisted generation row so the deep link fills in over time.
 *
 * Guard order mirrors /api/config's lighter follow-on chain (no per-IP daily cap: the
 * budget generation already consumed a slot), but it still reserves against the global
 * daily spend ceiling on a cache MISS because it spends real tokens.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { AppContext } from "../app/context.js";
import type { Usage } from "../llm/provider.js";
import type { ArchitectureBeforeCost, GeneratedTier, Tier, TierName } from "../schema/architecture.js";

import { clientIp } from "../guards/clientIp.js";
import { assertWithinInputBudget } from "../guards/inputCap.js";
import { llmCostUsd, provisionalLlmCostUsdFromConfig, reserveSpend } from "../guards/spend.js";

import { addTierToDesign } from "../pipeline/generate.js";
import { estimateCosts, trafficVolumeScale } from "../pipeline/cost.js";
import { scrubObject } from "../pipeline/scrub.js";
import { tagDesign } from "../pipeline/tags.js";

import { hashPrompt } from "../store/responseCache.js";
import { emitTelemetry, telemetryRecord } from "../obs/telemetry.js";

const ROUTE = "/api/generate/tier";

interface AddTierBody {
  description: string;
  answers?: string[];
  round?: number;
  /** Which tier to add — only balanced/resilient (budget comes from /api/generate). */
  tier: TierName;
  /** The already-generated budget tier — the baseline the new tier is a delta of. */
  budgetTier: Tier;
  /** Optional id of the persisted generation, so the added tier is merged into its row. */
  generationId?: string;
  turnstileToken?: string;
}

const addTierBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["description", "tier", "budgetTier"],
  properties: {
    description: { type: "string", minLength: 1, maxLength: 50_000 },
    answers: { type: "array", maxItems: 16, items: { type: "string" } },
    round: { type: "integer", minimum: 0, maximum: 8 },
    tier: { type: "string", enum: ["balanced", "resilient"] },
    budgetTier: { type: "object" },
    generationId: { type: "string", minLength: 1, maxLength: 128 },
    turnstileToken: { type: "string" },
  },
} as const;

export async function registerAddTierRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const inputCap: preHandlerHookHandler = async (req, reply) => {
    const body = req.body as AddTierBody;
    const text = [body.description, ...(body.answers ?? []), JSON.stringify(body.budgetTier)].join("\n");
    const verdict = await assertWithinInputBudget(ctx.provider, text, ctx.config.LLM_MAX_INPUT_TOKENS);
    if (!verdict.ok) {
      return reply.code(verdict.statusCode).send({
        error: "input_too_large",
        message: verdict.message,
        tokens: verdict.tokens,
        max: verdict.max,
      });
    }
  };

  app.post(
    ROUTE,
    {
      schema: { body: addTierBodySchema },
      // No daily-cap guard: add-tier is a follow-on to a generation already counted.
      preHandler: [ctx.guards.accessGate, ctx.guards.turnstile, ctx.guards.rateLimit.preHandler, inputCap],
    },
    (req, reply) => handleAddTier(ctx, req, reply),
  );
}

async function handleAddTier(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const startedAt = Date.now();
  const requestId = req.id;
  const body = req.body as AddTierBody;
  const ip = clientIp(req);
  const target = body.tier;
  const round = body.round ?? 0;
  const answers = body.answers ?? [];

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (u: Usage): void => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
  };
  const emit = (outcome: string, opts: { cacheHit?: boolean; costUsd?: number } = {}): void => {
    emitTelemetry(
      telemetryRecord({
        requestId,
        route: ROUTE,
        cacheHit: opts.cacheHit ?? false,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        latencyMs: Date.now() - startedAt,
        costUsd: opts.costUsd ?? 0,
        outcome,
        model: ctx.config.LLM_MODEL,
      }),
      ctx.telemetrySink,
    );
  };

  // Per-(prompt, tier) cache key — a re-add of the same tier is served free.
  const cacheKey = hashPrompt({
    description: body.description,
    answers,
    round,
    tier: target,
    model: ctx.config.LLM_MODEL,
    region: ctx.config.DEFAULT_REGION,
    kind: "addTier",
  });
  const cached = await ctx.stores.responseCache.get(cacheKey, ctx.config.RESPONSE_CACHE_TTL_MS);
  if (cached) {
    emit("ok", { cacheHit: true, costUsd: 0 });
    return reply.code(200).send(JSON.parse(cached.body));
  }

  // Reserve against the global daily ceiling BEFORE the real call (KTD7).
  const provisional = provisionalLlmCostUsdFromConfig(ctx.config);
  const reservation = await reserveSpend(ctx.stores.spendLedger, provisional, ctx.config.DAILY_SPEND_CEILING_USD);
  if (!reservation.ok || !reservation.reservation) {
    emit("refused", { costUsd: 0 });
    return reply.code(503).send({
      error: "daily_budget_reached",
      message: reservation.message,
      spentTodayUsd: reservation.spentTodayUsd,
      ceilingUsd: reservation.ceilingUsd,
    });
  }
  const reservationId = reservation.reservation.reservationId;

  try {
    const { tier: addedTier, usage: genUsage } = await addTierToDesign({
      provider: ctx.provider,
      memory: ctx.stores.memory,
      description: body.description,
      answers,
      opts: { maxTokens: ctx.config.LLM_MAX_TOKENS, effort: ctx.config.LLM_EFFORT },
      budgetTier: body.budgetTier as GeneratedTier,
      target,
    });
    addUsage(genUsage);

    // Cost the added tier alongside the budget baseline so compliance detection (read
    // from the whole design's surface) matches what the budget generation saw.
    const beforeCost: ArchitectureBeforeCost = {
      assumptions: [],
      clarificationsUsed: [],
      keyDecisions: [],
      securityFloor: [],
      recommendedTier: "budget",
      recommendationRationale: "",
      tiers: [body.budgetTier as GeneratedTier, addedTier],
    };
    const estimated = await estimateCosts(
      beforeCost,
      ctx.stores.pricing,
      ctx.config.DEFAULT_REGION,
      trafficVolumeScale(answers),
    );
    const costedTier = estimated.tiers.find((t) => t.name === target);
    if (!costedTier) throw new Error(`added tier '${target}' missing after cost estimation`);

    const actualUsd = llmCostUsd(usage, ctx.pricing);
    await ctx.stores.spendLedger.reconcile(reservationId, actualUsd);

    const scrubbed = scrubObject(costedTier);
    if (scrubbed.wasRedacted) req.log.warn({ route: ROUTE }, "secret shape redacted from added tier");
    const responseBody = { tier: scrubbed.value as Tier };

    // Merge the new tier into the persisted generation row (best-effort) so the deep
    // link + gallery fill in over time, and refresh the /api/generate response cache so
    // a re-run of the same prompt returns the tiers already added.
    if (body.generationId) {
      await mergeIntoGeneration(ctx, req, body.generationId, responseBody.tier, ip);
    }
    await ctx.stores.responseCache.set(cacheKey, JSON.stringify(responseBody));

    emit("ok", { costUsd: actualUsd });
    return reply.code(200).send(responseBody);
  } catch (err) {
    await ctx.stores.spendLedger.release(reservationId);
    emit("error", { costUsd: 0 });
    req.log.error({ err }, "add-tier generation failed");
    return reply.code(502).send({
      error: "generation_failed",
      message: "The design service is temporarily unavailable. Please try again.",
    });
  }
}

/**
 * Splice a newly-added tier into the stored generation body (and the response cache
 * keyed on that row's promptHash) so future deep-links / re-runs show it. Idempotent:
 * a tier is replaced by name, and the tiers are ordered budget → balanced → resilient.
 * Fully best-effort — a persistence failure never breaks the tier the user just got.
 */
async function mergeIntoGeneration(
  ctx: AppContext,
  req: FastifyRequest,
  id: string,
  tier: Tier,
  ip: string,
): Promise<void> {
  const order: Record<TierName, number> = { budget: 0, balanced: 1, resilient: 2 };
  try {
    const row = await ctx.stores.generations.getById(id);
    if (!row) return;
    const design = JSON.parse(row.body) as { tiers: Tier[] } & Record<string, unknown>;
    const tiers = [...design.tiers.filter((t) => t.name !== tier.name), tier].sort(
      (a, b) => order[a.name] - order[b.name],
    );
    const merged = { ...design, tiers };
    const mergedJson = JSON.stringify(merged);
    await ctx.stores.generations.upsert({
      promptHash: row.promptHash,
      description: row.description,
      answers: row.answers,
      model: row.model,
      region: row.region,
      recommendedTier: row.recommendedTier,
      tags: tagDesign(merged as never),
      body: mergedJson,
      clientIp: ip,
    });
    // The row's promptHash IS the /api/generate response-cache key — refresh it too.
    await ctx.stores.responseCache.set(row.promptHash, mergedJson);
  } catch (err) {
    req.log.error({ err }, "merge added tier into generation failed (non-fatal)");
  }
}
