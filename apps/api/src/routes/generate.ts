/**
 * POST /api/generate (U9) — composes the U8 guards → U5 pipeline → U7 cost → U15
 * telemetry into one request, and owns the ≤2-round clarification cap (R2).
 *
 * Guard order is the U8 chain and is load-bearing:
 *   access gate → Turnstile → per-IP rate limit → per-IP daily-cap CHECK (read-only)
 *   → input-token cap   ... then inside the handler ...   → ResponseCache lookup
 *   → clarification gate → global daily-spend reserve → record per-IP generation.
 *
 * WHY a cache hit skips the cap AND spend: a cached result costs zero tokens, so it
 * must not consume the per-IP daily allotment or the global ceiling — the tool stays
 * usable on cache for the rest of the day even after the budget is exhausted (KTD8).
 * Hence the daily-cap guard only CHECKS (read-only) up front; the increment happens
 * here, only after a cache MISS commits to a real generation.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { AppContext } from "../app/context.js";
import type { Usage } from "../llm/provider.js";
import type { ArchitectureResult } from "../schema/architecture.js";

import { clientIp } from "../guards/clientIp.js";
import { assertWithinInputBudget } from "../guards/inputCap.js";
import { llmCostUsd, provisionalLlmCostUsdFromConfig, reserveSpend } from "../guards/spend.js";

import { runClarify, roundCapReached } from "../pipeline/clarify.js";
import { assembleGrounding } from "../pipeline/ground.js";
import { generateArchitecture } from "../pipeline/generate.js";
import { retrieveSimilarDesigns, renderExemplars } from "../pipeline/retrieve.js";
import { estimateCosts, trafficVolumeScale } from "../pipeline/cost.js";
import { scrubAll, scrubObject, scrubPrompt } from "../pipeline/scrub.js";
import { tagDesign } from "../pipeline/tags.js";
import { researchMissingTopics } from "../research/bestPractice.js";

import { hashPrompt } from "../store/responseCache.js";
import { emitTelemetry, telemetryRecord } from "../obs/telemetry.js";

const ROUTE = "/api/generate";

interface GenerateBody {
  description: string;
  answers?: string[];
  round?: number;
  turnstileToken?: string;
  /** Skip the learning-network instant-serve and force a fresh generation ("generate fresh instead"). */
  freshOnly?: boolean;
}

/**
 * Request schema (R-validation): a missing/blank description, a non-array `answers`,
 * or an unknown field is a 400 — Fastify's default validation reply carries a clear
 * "body must have required property 'description'"-style message.
 */
const generateBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["description"],
  properties: {
    description: { type: "string", minLength: 1, maxLength: 50_000 },
    answers: { type: "array", maxItems: 16, items: { type: "string" } },
    round: { type: "integer", minimum: 0, maximum: 8 },
    turnstileToken: { type: "string" },
    freshOnly: { type: "boolean" },
  },
} as const;

export async function registerGenerateRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Last guard in the U8 chain: the hard input-token cap. Runs after validation
  // (body is present + well-typed) and after the cheaper rejects above it.
  const inputCap: preHandlerHookHandler = async (req, reply) => {
    const body = req.body as GenerateBody;
    const text = [body.description, ...(body.answers ?? [])].join("\n");
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
      schema: { body: generateBodySchema },
      preHandler: [
        ctx.guards.accessGate,
        ctx.guards.turnstile,
        ctx.guards.rateLimit.preHandler,
        ctx.guards.dailyCap.preHandler,
        inputCap,
      ],
    },
    (req, reply) => handleGenerate(ctx, req, reply),
  );
}

async function handleGenerate(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const startedAt = Date.now();
  const requestId = req.id;
  const body = req.body as GenerateBody;
  const ip = clientIp(req);
  const round = body.round ?? 0;
  // Scrub credential shapes from the prompt BEFORE it reaches the model, the cache key,
  // or storage. The model never sees a pasted secret (so it can't echo one back), and
  // the stored description == exactly what generated the body — no raw copy kept (Opt A).
  const scrubbedDescription = scrubPrompt(body.description);
  const scrubbedAnswers = scrubAll(body.answers ?? []);
  const description = scrubbedDescription.text;
  const answers = scrubbedAnswers.texts;
  if (scrubbedDescription.wasRedacted || scrubbedAnswers.wasRedacted) {
    req.log.info({ route: ROUTE }, "prompt redacted before generation");
  }

  // Accumulate token usage across every LLM call in this request (clarify + research
  // + generate) so the ledger reconcile and the telemetry line report the true cost.
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (u: Usage): void => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
  };

  const emit = (
    outcome: string,
    opts: { cacheHit?: boolean; costUsd?: number; researchCalls?: number } = {},
  ): void => {
    emitTelemetry(
      telemetryRecord({
        requestId,
        route: ROUTE,
        cacheHit: opts.cacheHit ?? false,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        researchCalls: opts.researchCalls ?? 0,
        latencyMs: Date.now() - startedAt,
        costUsd: opts.costUsd ?? 0,
        outcome,
      }),
      ctx.telemetrySink,
    );
  };

  // Cache key: the normalized prompt + the params that change the output. `round`
  // is included so a round-2 forced generation can't collide with a round-0 answer
  // for the same text; model + region make the key safe across config changes.
  const cacheKey = hashPrompt({
    description,
    answers,
    round,
    model: ctx.config.LLM_MODEL,
    region: ctx.config.DEFAULT_REGION,
  });

  // (2) ResponseCache lookup. HIT short-circuits: no cap, no spend, costUsd 0 (KTD8).
  const cached = ctx.stores.responseCache.get(cacheKey, ctx.config.RESPONSE_CACHE_TTL_MS);
  if (cached) {
    emit("ok", { cacheHit: true, costUsd: 0 });
    return reply.code(200).send(JSON.parse(cached.body));
  }

  // (2.5) Semantic learning network: RAG over our own APPROVED designs. A near-exact
  // match is served verbatim ($0, no LLM, no cap — like a cache hit, but across SIMILAR
  // prompts, not just identical ones); a weaker match becomes grounding exemplars for
  // the generation below. Fully non-fatal: any failure degrades to a normal generation.
  const retrieval = await retrieveSimilarDesigns({
    embedder: ctx.embedder,
    stores: ctx.stores,
    config: ctx.config,
    description,
    answers,
  });
  if (retrieval.instant && !body.freshOnly) {
    const lib = retrieval.instant;
    const responseBody = {
      ...lib.body,
      id: lib.id,
      fromLibrary: {
        basedOnPrompt: lib.prompt,
        similarity: Number(retrieval.topSimilarity.toFixed(3)),
      },
    };
    emit("library", { cacheHit: true, costUsd: 0 });
    return reply.code(200).send(responseBody);
  }
  const exemplarsSection = renderExemplars(retrieval.exemplars);

  // (3) Clarification gate (R2). Below the cap we may ask; once the cap is reached we
  // force generation regardless of whether the model still wants to clarify.
  if (!roundCapReached(round)) {
    const { result: clarification, usage: clarifyUsage } = await runClarify(
      ctx.provider,
      description,
      answers.length > 0 ? answers : undefined,
    );
    addUsage(clarifyUsage);
    if (clarification.needsClarification) {
      // No generation happened, so nothing is debited to the ledger; we still report
      // the (bounded, cheap) clarify-call cost for observability.
      emit("clarify", { costUsd: llmCostUsd(usage, ctx.pricing) });
      return reply.code(200).send({
        needsClarification: true,
        questions: clarification.questions,
        round,
      });
    }
  }

  // (4) Reserve against the global daily ceiling BEFORE generating (KTD7). The reserve
  // is transactional in the ledger, so concurrent requests cannot overshoot.
  const provisional = provisionalLlmCostUsdFromConfig(ctx.config);
  const reservation = reserveSpend(ctx.stores.spendLedger, provisional, ctx.config.DAILY_SPEND_CEILING_USD);
  if (!reservation.ok || !reservation.reservation) {
    emit("refused", { costUsd: 0 });
    // 503: the service is temporarily unavailable for NEW generations; cache still serves.
    return reply.code(503).send({
      error: "daily_budget_reached",
      message: reservation.message,
      spentTodayUsd: reservation.spentTodayUsd,
      ceilingUsd: reservation.ceilingUsd,
    });
  }
  const reservationId = reservation.reservation.reservationId;

  // Now it is a real generation — consume the per-IP daily allotment.
  ctx.guards.dailyCap.recordIpGeneration(ip);

  let researchCalls = 0;
  try {
    // Optional research-on-miss: persist quarantined facts so this and future requests
    // are grounded; count its token usage toward the request's spend (R11).
    if (ctx.config.RESEARCH_ON_MISS) {
      const { missingTopics } = assembleGrounding({ description, answers, memory: ctx.stores.memory });
      if (missingTopics.length > 0) {
        const summary = await researchMissingTopics({
          topics: missingTopics,
          memory: ctx.stores.memory,
          config: ctx.config,
          onSpend: addUsage,
        });
        researchCalls = summary.calls;
      }
    }

    const generated = await generateArchitecture({
      provider: ctx.provider,
      memory: ctx.stores.memory,
      description,
      answers,
      opts: { maxTokens: ctx.config.LLM_MAX_TOKENS, effort: ctx.config.LLM_EFFORT },
      exemplarsSection,
    });
    addUsage(generated.usage);

    // (U7) Fill cost drivers deterministically from the PricingStore — never the model.
    // Traffic is its own axis now: the intake "expected monthly visitors" answer drives
    // ONE volume scale applied equally to all three tiers (tiers differ by robustness,
    // not traffic); absent → the sensible default band.
    const estimated = estimateCosts(
      generated.result,
      ctx.stores.pricing,
      ctx.config.DEFAULT_REGION,
      trafficVolumeScale(answers),
    );

    // Reconcile the provisional reserve to the ACTUAL request cost (KTD7).
    const actualUsd = llmCostUsd(usage, ctx.pricing);
    ctx.stores.spendLedger.reconcile(reservationId, actualUsd);

    // Defense-in-depth: scrub the OUTPUT too. The input was scrubbed before the model
    // saw it, but redact any credential shape that slipped through into free-text fields
    // (assumptions, summaries, rationale) before it is returned, cached, or stored.
    const scrubbedOutput = scrubObject(estimated);
    if (scrubbedOutput.wasRedacted) {
      req.log.warn({ route: ROUTE }, "secret shape redacted from generation output");
    }

    // Return the full validated result (tiers + costs + the global securityFloor +
    // the opinionated recommendation + ADR keyDecisions). Spreading the whole
    // object — rather than cherry-picking fields — keeps the response in sync with
    // the schema so a later field addition can't be silently dropped (securityFloor
    // was). The full shape is what gets cached, so a cache HIT returns it too.
    const responseBody: ArchitectureResult & { id?: string } = { ...scrubbedOutput.value };

    // Persist every real generation permanently (the gallery + model/template backbone).
    // Best-effort: a persistence failure must NEVER break the user's generation. The id
    // becomes the deep link (/design/:id) and rides in the cached body so a cache HIT
    // returns it too. Off in test/probe envs (PERSIST_GENERATIONS) so they don't pollute.
    if (ctx.config.PERSIST_GENERATIONS) {
      try {
        const { id } = ctx.stores.generations.upsert({
          promptHash: cacheKey,
          description,
          answers,
          model: ctx.config.LLM_MODEL,
          region: ctx.config.DEFAULT_REGION,
          recommendedTier: responseBody.recommendedTier,
          tags: tagDesign(responseBody),
          body: JSON.stringify(responseBody),
          clientIp: ip,
        });
        responseBody.id = id;
      } catch (err) {
        req.log.error({ err }, "generation persistence failed (non-fatal)");
      }
    }

    ctx.stores.responseCache.set(cacheKey, JSON.stringify(responseBody));

    emit("ok", { costUsd: actualUsd, researchCalls });
    return reply.code(200).send(responseBody);
  } catch (err) {
    // Generation failed: release the reservation so the budget isn't consumed by a
    // call that produced nothing, then surface a clean upstream error.
    ctx.stores.spendLedger.release(reservationId);
    emit("error", { costUsd: 0, researchCalls });
    req.log.error({ err }, "generation failed");
    return reply.code(502).send({
      error: "generation_failed",
      message: "The design service is temporarily unavailable. Please try again.",
    });
  }
}
