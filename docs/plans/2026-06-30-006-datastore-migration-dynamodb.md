# Datastore migration: SQLite → DynamoDB (the real go-live blocker)

**Status:** handoff for a FRESH session (2026-06-30). **Goal:** make Drafture's runtime
match the serverless/DynamoDB story it preaches — replace the single-box SQLite datastore
with DynamoDB so the app is stateless and can go live serverless-first. This has been
asked for repeatedly and keeps getting deferred because it was bolted onto other work;
it is its own focused refactor. Do it in a clean session, on its own branch.

## 0. Why this unblocks everything

- **Go-live is blocked on it.** The self-host deploy is currently a single public EC2 box
  with the SQLite file on an EBS volume (+ DLM snapshots). That shape exists ONLY because
  the app is stateful on local SQLite. Move state to DynamoDB → the box becomes stateless →
  the deploy collapses to serverless-no-VPC (or one tiny stateless box), the EBS volume /
  snapshot machinery disappears, and "generate the self-host Terraform from our own product"
  finally produces a clean, lean, 100%-templated file (today it falls back to a TODO because
  the standalone SQLite-EBS volume has no emitter).
- **It's a backend swap, not a rewrite.** Every caller already depends on the store
  INTERFACES in `apps/api/src/store/types.ts` (KTD5 — "a Redis implementation can drop in
  behind the same interfaces without changing callers"). Implement those interfaces against
  DynamoDB and swap the factory; routes/pipeline code does not change.

## 1. The eight interfaces to re-implement (this IS the scope)

All in `apps/api/src/store/types.ts`. SQLite impls live in `apps/api/src/store/*.ts`,
wired by `createStores(db)` in `store/sqlite.ts`. The DynamoDB effort is one new impl per
interface + a new factory.

| Interface | SQLite file | Access patterns (drive the key design) |
|---|---|---|
| `MemoryStore` | `memory.ts` | `get(topic)`, `search(topics[])`, `getById`, `listPending` (verified=false), `upsert`, `setVerified`, `delete` |
| `ResponseCache` | `responseCache.ts` | `get(promptHash, ttlMs)`, `set` — **native DynamoDB TTL attribute** |
| `PricingStore` | `pricing.ts` | `get(service, region)` → all units; `replaceMonth(region, month, rows)` (atomic per region+month); `seed` |
| `SpendLedger` | `spendLedger.ts` | `reserve(provisional, ceiling)` / `reconcile` / `release` / `spentTodayUsd`; `incrementIpCount(ip)` / `ipCountToday` — **the hard one (see §3)** |
| `CuratedStore` | `curated.ts` | `list()` (score-ranked, hidden filtered), `get(id)`, `upsert`, `setHidden`, `vote(id, voter, ±1)` (one vote per voter) |
| `FeedbackStore` | `feedback.ts` | `upsert` (UNIQUE `ip`+`promptHash` → change, never stack), `listByRating(rating, limit)` newest-first |
| `GenerationsStore` | `generations.ts` | `upsert`-by-promptHash, `getById`, `getByPromptHash`, `listPending`/`listApproved` (score-ranked), `setStatus`, `setTerraform`/`getTerraform`, `vote` (auto-hide at threshold) |
| `DesignVectorStore` | `designVectors.ts` | `upsert`, `hasForModel`, `count(model)`, `search(vector, model, topK)` brute-force cosine, `delete` |

## 2. Recommended table design (single-table or per-store — pick one, document it)

Default to **one table per store** first (simplest, clear capacity, easy to reason about);
single-table is an optimization, not required at this traffic. Key sketches:

- **memory:** PK=`id`. GSI1 PK=`topic` (for `get`/`search`). `listPending` → GSI on
  `verified` (sparse: only index unverified) or a small scan (corpus is tiny).
- **responseCache:** PK=`promptHash`; `expiresAt` epoch-seconds attribute with **TTL enabled**
  (drop the manual TTL check — but keep a defensive in-read check, TTL deletion lags ≤48h).
- **pricing:** PK=`service#region`, SK=`month#unit`. `get(service,region)` = Query by PK.
  `replaceMonth` = Query GSI(`region#month`) → batch-delete + batch-put (no cross-row txn
  needed; it's a refresh).
- **spendLedger:** see §3 — day-keyed counter item + reservation items + per-IP counter.
- **curated / generations:** PK=`id`; votes as child items PK=`id`, SK=`vote#<voter>`;
  counters via atomic `UpdateItem ADD`; `vote` recompute = conditional put of the vote item
  (one per voter) then ADD the delta. Lists (`listApproved`/`listPending`/`list`) → GSI on
  `status` with a score sort key, OR scan+sort in app (corpus is small today — measure
  before indexing). `getByPromptHash` → GSI on `promptHash`. `terraformJson` stays a JSON
  attribute; `setTerraform` = `UpdateItem` merging one tier key.
- **feedback:** PK=`ip#promptHash` (gives the upsert-not-stack semantics for free).
  `listByRating` → GSI PK=`rating`, SK=`updatedAt`.
- **designVectors:** PK=`id`. GSI PK=`model` to pull the same-model corpus; `search` Queries
  that GSI then runs cosine in app (reuse `vectorMath.ts` unchanged). Fine at small N; if the
  corpus grows past a few thousand, revisit (OpenSearch / pgvector / a vector service).

## 3. The genuinely hard parts (do NOT hand-wave these — write integration tests)

1. **SpendLedger ceiling with no overshoot.** SQLite gets this free by serializing writers;
   DynamoDB does not. Implement `reserve` as an **optimistic-concurrency** loop on a single
   day-counter item: read `spentToday` (+ `version`), then `UpdateItem` `SET spentToday =
   spentToday + :p, version = version + 1` with `ConditionExpression version = :v AND
   spentToday + :p <= :ceiling`; on `ConditionalCheckFailed`, re-read and retry (bounded).
   Store each reservation as its own item (`reservationId`) so `reconcile` (adjust by
   actual−provisional) and `release` (subtract provisional) are exact. This is the one place
   a naive port silently lets concurrent requests blow the daily spend ceiling — **test it
   under concurrency.**
2. **One-vote-per-voter (curated + generations).** Keep a vote item per (design, voter);
   `vote` = conditional write of that item + an atomic counter delta, so re-clicking changes
   the prior vote instead of stacking (today's `UNIQUE(ip, prompt_hash)` / `UNIQUE(voter)`).
   The generations auto-hide-at-threshold check piggybacks on the post-update counts.
3. **PricingStore.replaceMonth atomicity.** Today it's a transaction. On DynamoDB do
   delete-then-put in batches; a reader mid-refresh may see a partial month — acceptable for
   a monthly offline job, but document it (or write to a new `month` and flip a pointer).

## 4. Factory + config (the swap point)

- Keep `createStores()` as the seam. Add `createDynamoStores(config)` returning the SAME
  `Stores` shape, and select by env: `STORE_BACKEND=sqlite|dynamodb` (provider-abstracted,
  factory-selected — the house style). Routes/pipeline import `Stores`, never a backend.
- **Dual-backend (DECIDED 2026-06-30).** Keep SQLite as the **dev/test** backend (the 369
  existing tests use `openTempDb()` in-memory — fast, hermetic) and run **DynamoDB in prod**. This
  keeps the test suite green with near-zero churn while prod goes serverless. The DynamoDB
  impls get their OWN integration tests against a local emulator (see §5).
- Config: replace `DB_PATH` with `STORE_BACKEND` + (for dynamodb) `AWS_REGION` and a table
  name prefix. `getConfig()` in `apps/api/src/config.ts`.

## 5. Testing the DynamoDB impls (don't trust an un-emulated port)

- Add **DynamoDB Local** (amazon's jar / `dynamodb-local` docker) or **dynalite** for
  integration tests of the 8 DynamoDB impls — especially the SpendLedger concurrency test
  and the vote-dedup test. Gate them behind a tag so unit CI stays fast.
- Reuse the existing `*.test.ts` behavioral expectations per store as the conformance spec:
  ideally run the SAME test body against both backends (parameterize the store factory) so
  DynamoDB is proven to match SQLite semantics exactly.

## 6. Data migration (existing local data) — MIGRATE, don't re-seed (DECIDED)

The live data lives ONLY in the gitignored `data/drafture.db`. As of 2026-06-30 it holds
**5 curated designs + 10 approved generations + their embeddings + votes** (caches are
disposable). **Carry it via a $0 one-shot `scripts/_migrateSqliteToDynamo.ts`** that reads
each store through the SQLite impl and `upsert`s into the DynamoDB impl — no LLM, both
backends already implement the same interfaces so this is a straight copy loop. Migrate only
**curated + approved generations + embeddings + votes**; skip response/pricing/memory-research/
spend caches (they rebuild).

> Re-seeding (`scripts/seedCurated.ts`, ~$0.60–0.90 of Sonnet for the 6 curated prompts) is
> NOT the path: it re-pays for the curated AND discards the 10 approved user generations + the
> RAG embeddings. Decided: migrate, not re-seed.

## 7. Downstream consequences once state is on DynamoDB

- **Self-host deploy gets simpler/leaner.** No SQLite-EBS volume, no DLM snapshots, no
  single-writer pinning. The box (if kept) is stateless behind Cloudflare; or move the API to
  Lambda + API Gateway entirely (true serverless-no-VPC, ~$0 idle). Either way the security
  floor stays the tiered one we just shipped (budget = free floor).
- **Regenerate Drafture's own self-host design (dogfood)** through the product with the
  DynamoDB reality, then emit its Terraform — that finally yields the clean, 100%-templated,
  rock-solid self-host `.tf` (no EBS-unsupported fallback). This closes the "get the TF from
  our product" request.
- An **EBS standalone emitter** is then NOT needed for self-host. (If you still want it for
  customer designs that legitimately use a file DB on a box, it's a 20-line emitter modeled on
  `emitPostgres` in `compute.ts` — but it is NOT on the go-live path anymore.)

## 8. Suggested sequence (each step independently green)

1. Land/merge the current `feat/tiered-security-floor` branch first (374 api tests green) so
   migration starts from a clean main.
2. New branch `feat/datastore-dynamodb`. Add the DynamoDB impls one store at a time, simplest
   first (`responseCache` → `pricing` → `memory` → `feedback` → `curated` → `generations` →
   `designVectors` → `spendLedger` last, it's hardest), each with emulator tests.
3. Add the factory + `STORE_BACKEND` config; keep SQLite default so the suite stays green.
4. Parameterize the store conformance tests to run against both backends; get DynamoDB green.
5. Data migration script (or re-seed decision).
6. Regenerate the self-host design + emit its Terraform from the product; verify 100%
   coverage / 0 gaps / terraform-valid, lean budget.
7. THEN resume go-live (the existing runbook: raise Console limit → prod key → provision →
   seed → smoke test), now serverless.

## 9. What to hand the new session (verbatim)

> Read `docs/plans/2026-06-30-006-datastore-migration-dynamodb.md`. Goal: migrate Drafture's
> store layer from SQLite (`better-sqlite3`, `data/drafture.db`) to DynamoDB behind the
> existing `apps/api/src/store/types.ts` interfaces, dual-backend (SQLite for dev/test,
> DynamoDB for prod) selected by `STORE_BACKEND`. Implement the 8 interfaces against DynamoDB
> with emulator-backed integration tests, factory-select, then regenerate the self-host design
> + Terraform from the product. The SpendLedger ceiling (no overshoot) and per-voter vote
> dedup are the load-bearing semantics — test them under concurrency, do not hand-wave.

## 10. Out of scope (say so, don't drift)

- No change to routes/pipeline/LLM code — they consume `Stores` and must keep working.
- No single-table-design rabbit hole unless a measured access pattern needs it.
- No vector-DB service for embeddings yet — brute-force cosine over the small same-model
  corpus is fine; revisit only past a few thousand designs.
