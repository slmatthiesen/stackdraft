/**
 * POST /api/config (staff-architect reference artifact) — hands back ONE best-fit
 * reference-only Terraform (HCL) file for a single, already-generated tier. It is
 * generated on demand and cached so repeat requests cost nothing, respecting the
 * $5/day ceiling — not a multi-format export buffet.
 *
 * Guard order mirrors /api/generate's friction chain but is DELIBERATELY lighter:
 *   access gate → Turnstile → per-IP rate limit → input-token cap
 *   ... then inside the handler ... → ResponseCache lookup → global daily-spend reserve.
 *
 * WHY config skips the per-IP daily generation cap but NOT the spend ceiling: a
 * config request is a follow-on to a generation the user has ALREADY paid for with
 * a per-IP slot, so charging a second slot would penalize finishing the workflow.
 * The global dollar ceiling, by contrast, is the real cost backstop (KTD8) and a
 * config call still spends real tokens, so it must reserve against the ceiling on
 * a cache MISS — and, like generate, a cache HIT skips the reserve entirely (zero
 * tokens, zero dollars).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { AppContext } from "../app/context.js";
import type { Usage } from "../llm/provider.js";
import type { Tier } from "../schema/architecture.js";

import { assertWithinInputBudget } from "../guards/inputCap.js";
import { llmCostUsd, provisionalLlmCostUsd, reserveSpend } from "../guards/spend.js";

import { hashPrompt } from "../store/responseCache.js";
import { emitTelemetry, telemetryRecord } from "../obs/telemetry.js";

import { assembleTier } from "../pipeline/terraform/assemble.js";
// Terraform artifact framing + the wire-up-gap detector now live in
// pipeline/terraform/wireup.ts so the deterministic assembler can reuse them without
// importing this route (that would cycle). Re-exported below so existing importers
// (the offline generator, the route tests) keep importing them from here unchanged.
import {
  REFERENCE_WARNING_HEADER,
  type WireupGap,
  annotateWireupGaps,
  detectWireupGaps,
  flagIfIncomplete,
  stripCodeFence,
} from "../pipeline/terraform/wireup.js";
export {
  REFERENCE_WARNING_HEADER,
  type WireupGap,
  annotateWireupGaps,
  detectWireupGaps,
  flagIfIncomplete,
  stripCodeFence,
};

const ROUTE = "/api/config";
const FORMAT = "terraform";

/**
 * Read a persisted tier's Terraform, checking both stores an id may belong to: a
 * fresh/community generation (GenerationsStore) or an admin-curated example
 * (CuratedStore) — the client passes whichever id the design actually opened under
 * (see api.ts `fetchDesign`'s generation→curated fallback), and this mirrors it
 * server-side so curated examples get the same $0 free-read cache as generations.
 */
async function readStoredTerraform(
  ctx: AppContext,
  generationId: string,
  tierName: string,
): Promise<{ code: string } | undefined> {
  const fromGeneration = await ctx.stores.generations.getTerraform(generationId, tierName);
  if (fromGeneration) return fromGeneration;
  return ctx.stores.curated.getTerraform(generationId, tierName);
}

/**
 * Persist a tier's Terraform onto whichever row owns this id. Both stores'
 * `setTerraform` return false (never throw) for an id they don't own, so trying
 * curated on a generations miss is one cheap extra read — best-effort throughout,
 * since a persist failure must never break the artifact the user just paid for.
 */
async function persistTerraform(
  ctx: AppContext,
  req: FastifyRequest,
  generationId: string,
  tierName: string,
  code: string,
): Promise<void> {
  try {
    const savedToGeneration = await ctx.stores.generations.setTerraform(generationId, tierName, code);
    if (!savedToGeneration) await ctx.stores.curated.setTerraform(generationId, tierName, code);
  } catch (err) {
    req.log.error({ err }, "terraform persist failed (non-fatal)");
  }
}

/**
 * Output budget for the reference-config call. Sized to fit a COMPLETE single-tier
 * HCL file: smaller caps truncated real designs mid-resource (2500 cut the self-host
 * budget tier; 16000 cut the notification-system RESILIENT tier — full security floor
 * across 2 regions, ~109 resources). 32000 is above the provider STREAMING_THRESHOLD
 * (16000) so the call streams past the SDK HTTP timeout, and below Sonnet 4.6's 64K
 * output ceiling. `flagIfIncomplete` is the backstop for any design that still
 * overflows. The provisional spend reserve is sized off this number; a cache HIT costs
 * $0 and the reserve reconciles to the actual (usually far smaller) output on a MISS.
 */
const CONFIG_MAX_OUTPUT_TOKENS = 32_000;

interface ConfigBody {
  tier: Tier;
  description?: string;
  /** Optional id of the persisted generation this tier belongs to (lazy Terraform cache). */
  generationId?: string;
  turnstileToken?: string;
}

/**
 * Body validation (R-validation): `tier` is required and must be an object — a
 * missing or non-object tier is a 400 with Fastify's default validation message.
 * The tier is shape-validated only shallowly here; the provider serializes it.
 */
const configBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tier"],
  properties: {
    tier: { type: "object" },
    description: { type: "string", maxLength: 50_000 },
    generationId: { type: "string", minLength: 1, maxLength: 128 },
    turnstileToken: { type: "string" },
  },
} as const;

export async function registerConfigRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Hard input-token cap on the serialized tier — bounds the input bill the same
  // way /api/generate does, after validation has confirmed the body is well-typed.
  const inputCap: preHandlerHookHandler = async (req, reply) => {
    const body = req.body as ConfigBody;
    const text = JSON.stringify(body.tier);
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
      schema: { body: configBodySchema },
      // No daily-cap guard here: config is a follow-on to an already-counted
      // generation (see file header). Spend is still bounded by the ceiling reserve.
      preHandler: [
        ctx.guards.accessGate,
        ctx.guards.turnstile,
        ctx.guards.rateLimit.preHandler,
        inputCap,
      ],
    },
    (req, reply) => handleConfig(ctx, req, reply),
  );
}

async function handleConfig(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const startedAt = Date.now();
  const requestId = req.id;
  const body = req.body as ConfigBody;
  const tier = body.tier;

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
      }),
      ctx.telemetrySink,
    );
  };

  // Cache key: the tier graph + the artifact format. The same tier always yields the
  // same reference config, so an identical request is served free from cache.
  const cacheKey = hashPrompt({ tier, format: FORMAT });

  // (0) Long-lived Terraform cache on the owning row (lazy-persist) — a fresh/
  // community generation OR an admin-curated example, whichever this id belongs to.
  // Survives the 24h response cache and serves gallery/example pulls for $0 — the
  // first config request for a (design, tier) pays; every later pull, by anyone, is
  // a free read. The client supplies generationId when the design was persisted;
  // without it we fall through to the normal on-demand + 24h-cache path.
  const tierName = typeof tier?.name === "string" ? tier.name : undefined;
  const generationId = body.generationId;
  if (generationId && tierName) {
    const stored = await readStoredTerraform(ctx, generationId, tierName);
    if (stored) {
      emit("ok", { cacheHit: true, costUsd: 0 });
      return reply.code(200).send({ format: FORMAT, code: stored.code });
    }
  }

  // (1) ResponseCache lookup. HIT short-circuits: no spend, costUsd 0 (KTD8).
  const cached = await ctx.stores.responseCache.get(cacheKey, ctx.config.RESPONSE_CACHE_TTL_MS);
  if (cached) {
    emit("ok", { cacheHit: true, costUsd: 0 });
    return reply.code(200).send(JSON.parse(cached.body));
  }

  // (1.5) Deterministic Terraform — emit the reference HCL straight from the typed
  // graph. A tier whose every node has an emitter is rendered with NO LLM call: $0,
  // instant, no spend reserve, and its wire-up gaps are structurally impossible. A
  // tier containing an unsupported service falls through to the LLM path below (the
  // hybrid long-tail fallback). We cache + persist it exactly like the LLM result so
  // later pulls are free reads, and skip the daily-ceiling reserve entirely (no spend).
  if (ctx.config.TERRAFORM_DETERMINISTIC) {
    try {
      const assembled = assembleTier(tier, { region: ctx.config.DEFAULT_REGION });
      if (assembled.coverage.unsupported.length === 0) {
        const responseBody = { format: FORMAT, code: assembled.code };
        if (generationId && tierName) {
          await persistTerraform(ctx, req, generationId, tierName, responseBody.code);
        }
        await ctx.stores.responseCache.set(cacheKey, JSON.stringify(responseBody));
        emit("ok", { cacheHit: false, costUsd: 0 });
        return reply.code(200).send(responseBody);
      }
      req.log.info(
        { unsupported: assembled.coverage.unsupported, tier: tierName },
        "deterministic terraform partial — falling back to LLM for the long tail",
      );
    } catch (err) {
      // Never let an emitter bug fail the request — fall through to the LLM path.
      req.log.error({ err, tier: tierName }, "deterministic terraform failed (non-fatal) — LLM fallback");
    }
  }

  // (2) Reserve against the global daily ceiling BEFORE the real call (KTD7). The
  // provisional is sized off this route's small output budget, not the full
  // generation budget, so config calls don't over-reserve. No per-IP cap here.
  const provisional = provisionalLlmCostUsd(
    ctx.pricing,
    ctx.config.LLM_MAX_INPUT_TOKENS,
    CONFIG_MAX_OUTPUT_TOKENS,
  );
  const reservation = await reserveSpend(ctx.stores.spendLedger, provisional, ctx.config.DAILY_SPEND_CEILING_USD);
  if (!reservation.ok || !reservation.reservation) {
    emit("refused", { costUsd: 0 });
    // 503: cost ceiling reached for NEW work; cached configs still serve.
    return reply.code(503).send({
      error: "daily_budget_reached",
      message: reservation.message,
      spentTodayUsd: reservation.spentTodayUsd,
      ceilingUsd: reservation.ceilingUsd,
    });
  }
  const reservationId = reservation.reservation.reservationId;

  try {
    const generated = await ctx.provider.generateConfig(tier, { maxTokens: CONFIG_MAX_OUTPUT_TOKENS });
    addUsage(generated.usage);

    // Reconcile the provisional reserve to the ACTUAL measured cost (KTD7).
    const actualUsd = llmCostUsd(usage, ctx.pricing);
    await ctx.stores.spendLedger.reconcile(reservationId, actualUsd);

    const cleaned = stripCodeFence(generated.result);
    // Residual wire-up gaps the model still omitted — `terraform plan` stays green on
    // each, so this is the only place they surface. Non-fatal: annotateWireupGaps()
    // flags them in the artifact; the log line feeds back into strengthening the KB
    // rules (terraform-wireup-rules.json) so emissions improve over time.
    const gaps = detectWireupGaps(cleaned);
    if (gaps.length > 0) {
      req.log.warn({ gaps: gaps.map((g) => g.id), tier: tierName }, "terraform wire-up gaps detected");
    }

    const responseBody = {
      format: FORMAT,
      code: REFERENCE_WARNING_HEADER + flagIfIncomplete(annotateWireupGaps(cleaned)),
    };

    // Persist this tier's Terraform onto the owning row so future pulls are free.
    if (generationId && tierName) {
      await persistTerraform(ctx, req, generationId, tierName, responseBody.code);
    }

    await ctx.stores.responseCache.set(cacheKey, JSON.stringify(responseBody));

    emit("ok", { costUsd: actualUsd });
    return reply.code(200).send(responseBody);
  } catch (err) {
    // The call produced nothing — release the reservation so no budget lingers.
    await ctx.stores.spendLedger.release(reservationId);
    emit("error", { costUsd: 0 });
    req.log.error({ err }, "config generation failed");
    return reply.code(502).send({
      error: "config_generation_failed",
      message: "The config service is temporarily unavailable. Please try again.",
    });
  }
}
