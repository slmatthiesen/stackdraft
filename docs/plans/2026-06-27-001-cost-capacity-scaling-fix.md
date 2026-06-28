# Cost fix: capacity-scaling (DONE)

**Date:** 2026-06-27 · **Status:** ✅ DONE — implemented, 12/12 tests green, ready to commit/merge
**Branch:** `fix/cost-topology-scaling` · **Files:** `apps/api/src/pipeline/cost.ts`, `apps/api/src/pipeline/cost.test.ts`
**Remaining cost work (TODO):** `2026-06-27-002-cost-honesty-and-self-host-hosting.md`

## What shipped
Always-on CAPACITY units (`$/hr`, `$/vCPU-hr`, `$/GB-hr`, WAF ACL) were being multiplied by the
request-volume ladder (`TIER_VOLUME_SCALE` 0.1/1/10×) inside `monthlyBand` (cost.ts). They're priced
per hour of **uptime**, not per request, so they now scale by **topology only** (the per-tier
robustness multiplier) — via a `CAPACITY_UNITS` set + a 2-line guard in `monthlyBand`. Request,
storage, and payload-traffic units still scale with volume (correct, unchanged).

The one brittle test that had codified the buggy `volume × multiplier` formula for ALB was updated to
the topology-only expectation.

## Effect (verified on the self-host example)
| line | before | after |
|---|---|---|
| NAT gateway — budget | $3.28 | $32.85 |
| NAT gateway — resilient | $2,956 | $98.55 |
| per-tier minimum | ~$3 / ~$100 / ~$3,000 | ~$33 / ~$113 / ~$126 |

## Verify
- `pnpm --filter @drafture/api test src/pipeline/cost.test.ts` → 12/12 green.
- Recompute curated examples for $0:
  `DB_PATH=<gallery db> pnpm --filter @drafture/api exec tsx scripts/recomputeCuratedCosts.ts`

## Not in scope (separate roadmap)
The two OTHER cost gaps — **fixed mid-size seed pricing** (every EC2 = m5.large, every RDS = a $50
server) and the **service-matcher dropping Fargate/Aurora labels** — are NOT fixed here. See the
roadmap doc above.
