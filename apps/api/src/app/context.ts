/**
 * Application context (U9) — the single composition root the routes read from.
 *
 * `buildAppContext` opens storage, seeds the curated KB, builds the provider, and
 * instantiates the U8 guards once, so the route handlers stay thin (compose, don't
 * construct). `overrides` lets tests inject a fake `LlmProvider` and temp stores
 * (and a fake fetch / telemetry sink) without touching the network or a real DB.
 *
 * `registerApiRoutes` wires both route plugins onto a Fastify instance with this
 * context — the orchestrator calls `buildAppContext(config)` + `registerApiRoutes`
 * from server.ts during integration.
 */
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import { ClaudeProvider } from "../llm/claude.js";
import { GlmProvider } from "../llm/glm.js";
import type { EmbeddingProvider } from "../llm/embeddings/provider.js";
import { buildEmbeddingProvider } from "../llm/embeddings/factory.js";

import { getDb, createStores, type Db, type Stores } from "../store/sqlite.js";
import { seedKnowledgeBase } from "../store/kbLoader.js";

import { makeAccessGate } from "../guards/accessGate.js";
import { makeTurnstileGuard, type FetchFn } from "../guards/turnstile.js";
import { makeRateLimit, type RateLimiter } from "../guards/rateLimit.js";
import { makeDailyCap, type DailyCap } from "../guards/dailyCap.js";
import { pricingFromConfig, type LlmPricing } from "../guards/spend.js";

import type { TelemetrySink } from "../obs/telemetry.js";

import { registerGenerateRoute } from "../routes/generate.js";
import { registerClarifyRoute } from "../routes/clarify.js";
import { registerConfigRoute } from "../routes/config.js";
import { registerCuratedRoutes } from "../routes/curated.js";
import { registerDesignsRoutes } from "../routes/designs.js";
import { registerFeedbackRoute } from "../routes/feedback.js";

/** The U8 guard chain, pre-instantiated so every request reuses the same windows/ledger. */
export interface AppGuards {
  /** Optional HTTP-Basic demo gate (off unless creds configured). */
  accessGate: preHandlerHookHandler;
  /** Cloudflare Turnstile bot check (off unless a secret is configured). */
  turnstile: preHandlerHookHandler;
  /** Per-IP sliding-window rate limiter. */
  rateLimit: RateLimiter;
  /** Per-IP daily generation cap (check vs. record split — see dailyCap.ts). */
  dailyCap: DailyCap;
}

export interface AppContext {
  config: Config;
  provider: LlmProvider;
  /** Embedding provider for the semantic learning network; null when retrieval is off/unconfigured. */
  embedder: EmbeddingProvider | null;
  stores: Stores;
  /** Token→USD rates for ledger reconcile + telemetry (KTD7). */
  pricing: LlmPricing;
  guards: AppGuards;
  /** Injectable so tests capture the one-line-per-request telemetry. */
  telemetrySink?: TelemetrySink;
  /** The owned DB handle when this context opened it (undefined when stores are injected). */
  db?: Db;
}

export interface AppContextOverrides {
  /** Fake provider for tests (canned schema-valid results, no network). */
  provider?: LlmProvider;
  /** Fake/disabled embedder for tests. Pass `null` to exercise the retrieval-off path. */
  embedder?: EmbeddingProvider | null;
  /** Pre-built stores (e.g. an in-memory temp DB) — skips opening config.DB_PATH. */
  stores?: Stores;
  /** Capture telemetry lines in tests. */
  telemetrySink?: TelemetrySink;
  /** Stub the Turnstile siteverify call. */
  fetchFn?: FetchFn;
  /** Reuse an already-open DB handle alongside injected stores. */
  db?: Db;
}

/**
 * Build the composition root. Opens + seeds storage (idempotent), constructs the
 * provider and the guard chain. Pure wiring — no request-time work happens here.
 */
/** Select the LLM provider from config (KTD2): Anthropic by default, GLM when
 *  LLM_PROVIDER=glm. Both implement LlmProvider, so callers stay provider-agnostic. */
function buildProvider(config: Config): LlmProvider {
  return config.LLM_PROVIDER === "glm" ? GlmProvider.fromConfig(config) : ClaudeProvider.fromConfig(config);
}

export function buildAppContext(
  config: Config,
  overrides: AppContextOverrides = {},
): AppContext {
  let db = overrides.db;
  let stores = overrides.stores;
  if (!stores) {
    db = db ?? getDb(config.DB_PATH);
    stores = createStores(db);
  }
  // Idempotent — safe whether the DB is fresh or already seeded (kbLoader).
  seedKnowledgeBase(stores);

  const provider = overrides.provider ?? buildProvider(config);
  // `embedder` may be explicitly null in tests (exercise the retrieval-off path), so
  // distinguish "not provided" (build from config) from "provided as null" (disable).
  const embedder = "embedder" in overrides ? overrides.embedder ?? null : buildEmbeddingProvider(config, overrides.fetchFn);

  const guards: AppGuards = {
    accessGate: makeAccessGate({ user: config.ACCESS_GATE_USER, pass: config.ACCESS_GATE_PASS }),
    turnstile: makeTurnstileGuard({ secret: config.TURNSTILE_SECRET }, overrides.fetchFn),
    rateLimit: makeRateLimit({ max: config.RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS }),
    dailyCap: makeDailyCap(stores.spendLedger, { maxPerDay: config.PER_IP_DAILY_GENERATIONS }),
  };

  return {
    config,
    provider,
    embedder,
    stores,
    pricing: pricingFromConfig(config),
    guards,
    telemetrySink: overrides.telemetrySink,
    db,
  };
}

/** Register both API route plugins against the shared context. */
export async function registerApiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await registerGenerateRoute(app, ctx);
  await registerClarifyRoute(app, ctx);
  await registerConfigRoute(app, ctx);
  await registerCuratedRoutes(app, ctx);
  await registerFeedbackRoute(app, ctx);
  await registerDesignsRoutes(app, ctx);
}
