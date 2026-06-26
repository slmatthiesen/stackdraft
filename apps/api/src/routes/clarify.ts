/**
 * POST /api/clarify (U9) — the lightweight clarification probe (R2).
 *
 * Unlike /api/generate this never generates, reserves spend, or consumes the per-IP
 * generation cap: it only runs the access/bot/rate/input guards and the structured
 * clarify call, returning `{ needsClarification, questions }`. The route still emits
 * one telemetry line so every request is observable (U15).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { AppContext } from "../app/context.js";
import type { Usage } from "../llm/provider.js";

import { assertWithinInputBudget } from "../guards/inputCap.js";
import { llmCostUsd } from "../guards/spend.js";
import { runClarify } from "../pipeline/clarify.js";
import { emitTelemetry, telemetryRecord } from "../obs/telemetry.js";

const ROUTE = "/api/clarify";

interface ClarifyBody {
  description: string;
  answers?: string[];
  turnstileToken?: string;
}

const clarifyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["description"],
  properties: {
    description: { type: "string", minLength: 1, maxLength: 50_000 },
    answers: { type: "array", maxItems: 16, items: { type: "string" } },
    turnstileToken: { type: "string" },
  },
} as const;

export async function registerClarifyRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Same friction guards as /api/generate (access gate, bot check, rate limit), plus
  // the hard input-token cap — but no daily-cap/spend, since clarify does not generate.
  const inputCap: preHandlerHookHandler = async (req, reply) => {
    const body = req.body as ClarifyBody;
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
      schema: { body: clarifyBodySchema },
      preHandler: [
        ctx.guards.accessGate,
        ctx.guards.turnstile,
        ctx.guards.rateLimit.preHandler,
        inputCap,
      ],
    },
    (req, reply) => handleClarify(ctx, req, reply),
  );
}

async function handleClarify(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const startedAt = Date.now();
  const body = req.body as ClarifyBody;
  const answers = body.answers ?? [];

  const { result: clarification, usage } = await runClarify(
    ctx.provider,
    body.description,
    answers.length > 0 ? answers : undefined,
  );

  emitOne(ctx, req.id, usage, Date.now() - startedAt, clarification.needsClarification);

  return reply.code(200).send({
    needsClarification: clarification.needsClarification,
    questions: clarification.questions,
  });
}

function emitOne(
  ctx: AppContext,
  requestId: string,
  usage: Usage,
  latencyMs: number,
  needsClarification: boolean,
): void {
  emitTelemetry(
    telemetryRecord({
      requestId,
      route: ROUTE,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      latencyMs,
      // Clarify spend isn't ledger-reserved (bounded + cheap); reported for observability.
      costUsd: llmCostUsd(usage, ctx.pricing),
      outcome: needsClarification ? "clarify" : "ok",
    }),
    ctx.telemetrySink,
  );
}
