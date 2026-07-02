/**
 * Sentry client error monitoring — env-gated by VITE_SENTRY_DSN.
 *
 * Error capture ONLY: no session replay (records the DOM), no performance tracing, and
 * sendDefaultPii=false. This mirrors the server's privacy posture (apps/api obs/sentry.ts):
 * nothing the user typed into the prompt is sent to Sentry — only the crash stack. The DSN
 * is a public browser DSN (safe to ship in the client bundle; it can only submit events to
 * this project, origin-scoped). Unset → disabled, no-op.
 *
 * The default React integrations (global uncaught-error capture, breadcrumbs) stay on —
 * that's the core value. tracesSampleRate=0 turns off transaction/perf spans.
 */
import * as Sentry from "@sentry/react";

const DSN = import.meta.env.VITE_SENTRY_DSN;

export function initSentry(): void {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
}
