# Pre-launch follow-ups — 2026-06-29

Ordered queue after the speed/cost work merged to main (408617a: tier-delta emission,
calibrated learning network, structured-output hardening, terraform-wireup-rules).
Goal: consistent, correct, fast generations before the site goes live.

## 1. Completeness Critic — DO FIRST (correctness gate, blocks launch)

Deterministic property checks in `apps/api/test/golden/properties.ts` (free, run in the
eval gate every change — NOT a runtime LLM critic). Catches designs that reconstruct or
generate into a structurally-incomplete graph. Extra important now that tier-delta
reconstructs balanced/resilient from deltas.

Add these properties (each: success criterion → verify with a known-bad fixture that trips it):
- **graphHasNoDanglingEdges** — every edge `from`/`to` is a real node `id` (or `client`).
  Catches a delta that adds an edge referencing a removed/renamed/typo'd node id.
- **graphHasNoOrphanNodes** — every node appears in ≥1 edge (nothing added but unwired).
- **datastoreIsReachable** — if a tier has a datastore node (DynamoDB/RDS/Aurora/S3/…),
  at least one compute/API node has an edge to it (data isn't floating).
- **readPathWhenUiImplied** (the original idea) — if the design has a datastore AND the
  description/graph implies user-facing reads (UI / dashboard / public / GET API), require
  a path client → compute → datastore. Start LENIENT (warn) to avoid false fails; tighten
  against the golden set.

Verify: add a deliberately-broken fixture per property; run `pnpm --filter @drafture/api test`
and the golden eval; pass-rate must not regress on the 30 golden prompts (Sonnet).

## 2. Grow the corpus (compounds the learning-network cost win)

Corpus = 11 (5 approved gens + 6 curated). More approved designs → more instant-serve ($0)
and grounding hits. Steps:
- Generate the 30 golden prompts on **Sonnet** (`eval:haiku` harness pointed at sonnet, or a
  small batch script) → operator reviews each → approve the good ones
  (`reviewGenerations.ts approve <id>`) → `backfillEmbeddings.ts`.
- Quality bar matters: approved designs are served VERBATIM. Reject anything that fails the
  completeness gate from (1).

## 3. Regenerate the dogfood trade design

Do NOT embed the old `dogfood/trade-monitoring-handoff/design.json` — regenerate fresh against
the now-improved pipeline (tier-delta + wireup-rules + completeness gate), review, then decide
whether to keep/embed. It's the self-host dogfood case; it should pass the new gates cleanly.

## 4. Launch observability (lightweight — not pre-launch-blocking)

One structured per-generation telemetry line: `{outcome, model, outputTokens, latencyMs, cost,
retrievalHit, completenessOk}`. Most is already captured (spend ledger + generations table +
obs/telemetry). Add a daily cost/outcome rollup. Defer real APM/dashboards until after launch.

## Sequence
1 (completeness, blocks launch) → 4 (obs line, quick) → go-live (existing runbook) → 2 + 3 as
fast-follows. The learning network and tier-delta are already live on main.
