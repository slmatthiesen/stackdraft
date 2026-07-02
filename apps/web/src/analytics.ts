/**
 * Cloudflare Web Analytics beacon — the visitor-traffic lens.
 *
 * $0, edge-measured, cookieless, no consent banner (the reason we chose it over PostHog/
 * GA). Env-gated: the beacon loads only when the operator set VITE_CF_WEB_ANALYTICS_TOKEN
 * at build time (the token from the CF dashboard → Web Analytics snippet). Unset (dev,
 * previews) → nothing loads, no third-party request, no network.
 *
 * Intentionally a load-time pageview beacon, NOT full SPA route tracking. For a one-page
 * app whose gallery/design views are client-side route changes, this undercounts in-app
 * navigation; the initial-load signal (where traffic lands, referrers, countries) is the
 * $0 baseline we want now, and CF Web Analytics can be extended to fire on route change
 * later if that granularity is ever needed.
 */
const CF_TOKEN = import.meta.env.VITE_CF_WEB_ANALYTICS_TOKEN;

export function initAnalytics(): void {
  if (!CF_TOKEN || typeof document === "undefined") return;
  const script = document.createElement("script");
  script.defer = true;
  script.src = "https://static.cloudflareinsights.com/beacon.min.js";
  script.dataset.cfBeacon = JSON.stringify({ token: CF_TOKEN });
  document.head.appendChild(script);
}
