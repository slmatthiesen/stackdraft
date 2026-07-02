/**
 * Sentry error-monitoring wiring (optional, config-gated). When SENTRY_DSN is set, the
 * server captures unhandled exceptions + Fastify 500s as Sentry events. Unset → disabled,
 * no client, zero overhead — forker-safe, same posture as obs/langfuse.ts.
 *
 * PRIVACY IS THE DESIGN CONSTRAINT HERE: a generation 500 could otherwise drag the
 * submitted prompt (request body) into the Sentry event. Two independent guards keep
 * prompt text from ever leaving the box:
 *   1. sendDefaultPii = false.
 *   2. a beforeSend scrubber that deletes request.body / .data / .cookies and redacts
 *      auth/cookie headers from EVERY event, regardless of integration defaults. This is
 *      version-proof — it's the last stop before send.
 *
 * Distinct from obs/langfuse.ts, which captures full prompt/completion to the operator's
 * OWN private project for debugging. Sentry is a third party, so it gets traces only.
 */
import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

/** Headers that must never reach a third party. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "anthropic-api-key",
]);

/** Strip any request body / cookies / auth headers from an event before it ships. */
function scrub<T extends Sentry.Event>(event: T): T {
  const req = event.request;
  if (req) {
    // The prompt lives in the request body — drop it unconditionally.
    delete (req as { body?: unknown }).body;
    delete (req as { data?: unknown }).data;
    delete (req as { cookies?: unknown }).cookies;
    if (req.headers) {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        cleaned[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[redacted]" : String(v);
      }
      req.headers = cleaned;
    }
  }
  return event;
}

/** Initialize Sentry if configured. Returns whether it's active; false (no-op) when unset. */
export function initSentry(config: Config): boolean {
  if (!config.SENTRY_DSN) return false;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    sendDefaultPii: false,
    beforeSend: scrub,
  });
  return true;
}

/** Attach the Sentry Fastify error handler. No-op when Sentry isn't initialized. */
export function attachSentryErrorHandler(app: FastifyInstance, enabled: boolean): void {
  if (!enabled) return;
  Sentry.setupFastifyErrorHandler(app);
}
