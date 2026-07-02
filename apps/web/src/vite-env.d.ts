/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloudflare Web Analytics beacon token (from the CF dashboard snippet). Unset → no beacon. */
  readonly VITE_CF_WEB_ANALYTICS_TOKEN?: string;
  /** Sentry client DSN (public — browser DSNs are safe to ship in the bundle). Unset → no Sentry. */
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
