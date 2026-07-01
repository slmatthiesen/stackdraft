# Service catalog + agent memory — spec (cut output tokens by not re-typing canned context)

**Status:** spec / proposed (2026-06-30). **Trigger:** a budget generation decodes ~2837
output tokens ≈ 48s, and a large slice of that is *boilerplate the model re-types every
run*. Owner's framing: "when we know we need SQS, pull a hash of its context instead of
typing it fresh" (cf. Redis *Context retrieval for AI agents*, redis.io/blog/…).

## 0. The insight, made precise

The output-token drag is real, but "cache/memory" is TWO different mechanisms that solve
DIFFERENT halves of it. Conflating them is the trap. Both are worth building; only one is
the token cut.

| | **A. Deterministic Service Catalog** | **B. Semantic Memory / Cache (Redis-style)** |
|---|---|---|
| Shape | exact `key → value` hash (a dictionary) | fuzzy `embedding → nearest` (vector search) |
| Answers | "for an **SQS** node, what are the canned tags?" | "have we seen a **prompt like this** before?" |
| Cuts output on | **every** generation | only when a **similar request recurs** |
| Needs an LLM/vectors | no — pure lookup, $0, sub-µs | yes — embeddings + ANN |
| Owner's "hash with all the data" | **this** | — |
| Owner's "Paris→France instant recall" | — | **this** (Redis LangCache-style semantic cache) |

The measured token breakdown (representative 16-node budget design ≈ 3030 tok):

- keyDecisions **27%**, nodes **21%**, edges **19%**, assumptions **14%**, delta 6%,
  clarificationsUsed 6%, tradeoffs 4%, summary 2%.
- **Inside the nodes block (644 tok, ~40 tok/node):** `security[]` tags **46%**,
  `id+awsService` 29%, `role` 14%. **The security tags are the canned part** — "S3 →
  block public access, SSE-KMS"; "a queue → DLQ, idempotent consumer" — identical every
  design, keyed only by the service + the tier's floor.

So Layer A targets the ~46% of node tokens (and the normalizable `awsService` string)
that are a pure function of `(service, tier)`. Layer B targets latency for *repeat/similar*
prompts — which is a recurrence play, not a decode speedup for a novel design.

---

## 1. Layer A — Deterministic Service Catalog  *(the token cut; build this)*

**Principle (already ours — [[stackdraft-deterministic-vs-agentic]]):** move reusable
knowledge OUT of the model's output into the KB. We already do it for `costDrivers`
(server-computed) and the `securityFloor` (injected) — which is exactly why they're NOT
in the 2837. This extends the same move to per-node security tags + service naming.

### 1.1 The catalog (`@drafture/kb/service-catalog.json`)

Keyed by the **existing `ServiceKey` vocabulary** (`pipeline/terraform/serviceKey.ts`) so
ONE service vocabulary spans prompt ↔ emission ↔ TF emitter ↔ catalog (big synergy: a new
service is added once). Entry shape:

```jsonc
{
  "sqs": {
    "awsService": "Amazon SQS",              // canonical name (was model-typed)
    "defaultRole": "job queue",              // fallback when the model omits a role
    "floorTags": ["DLQ", "idempotent consumer", "SSE"],   // free-floor, every tier
    "paidTags": ["customer-managed CMK"],    // added only when the tier carries the paid floor
    "vpcBound": false
  },
  "s3":  { "awsService": "Amazon S3", "floorTags": ["block public access", "SSE-KMS at rest", "TLS-only bucket policy"], "paidTags": ["customer-managed CMK"] },
  "rds": { "awsService": "Amazon RDS (PostgreSQL)", "floorTags": ["private subnet", "SSE at rest", "no public access"], "paidTags": ["customer-managed CMK", "multi-AZ"], "vpcBound": true }
  // … one entry per ServiceKey we template
}
```

### 1.2 Lean emission schema

The model stops typing canned text; it emits the **pick + design-specific deltas only**:

```ts
LeanNode = {
  svc: string,            // a catalog key ("sqs") OR free text for a novel service
  id: string,
  role?: string,          // override only when the design-specific role ≠ defaultRole
  addSecurity?: string[]  // ONLY design-specific extras the catalog can't know
                          // (e.g. "idempotent — S3 key = job hash")
}
```

`~40 tok/node → ~12 tok/node` for the common case. Edges stay as-is (already minimal;
`from/to/payload/protocol` is genuine wiring, not boilerplate).

### 1.3 Hydration (`pipeline/hydrate.ts`, deterministic, $0)

Runs on the reconstructed graph BEFORE `estimateCosts`, so everything downstream (cost,
completeness gate, TF emitter, web) sees a normal full `Node` and is **unchanged**:

```
hydrate(leanNode, tier):
  entry   = catalog[normalizeServiceKey(leanNode.svc)]    // reuse the TF normalizer
  awsService = entry?.awsService ?? leanNode.svc          // fallback: model's text verbatim
  role       = leanNode.role ?? entry?.defaultRole ?? leanNode.svc
  security   = dedupe( entry.floorTags
                     + (tierCarriesPaidFloor(tier) ? entry.paidTags : [])   // securityTiers.ts
                     + (leanNode.addSecurity ?? []) )
```

- **Tier-aware** by reusing `securityTiers.ts` (`paidSecurityActive`): budget gets the
  free-floor tags; balanced+ automatically gains the CMK/WAF/multi-AZ tags — *the same
  tiered-floor logic the emitter + gate already use*, now applied to tags too. Consistency
  for free.
- **Coverage/fallback:** a `svc` with no catalog entry keeps the model's `svc` string as
  `awsService` and its `addSecurity` as the tags — **novel services still work**. Emit a
  `catalog_miss` telemetry line (same pattern as the TF unsupported-service histogram) so
  the next catalog entry to add is obvious, not guessed.

### 1.4 Token math + trade-offs

- **Cut:** ~46% of the node block (security) + `awsService` normalization ≈ **~10–12% of
  total output**, on *every* generation. Optionally also trim `assumptions` +
  `clarificationsUsed` prompt mandates (~20% of output, lower value) → realistic
  **~2837 → ~2200 tok (~48s → ~37s)**. Modest but compounding and $0-at-serve.
- **Trade-off (name it):** catalog tags are *deterministic per (service, tier)* — the
  model loses the chance to tailor a floor tag to the design. Mitigation: `addSecurity[]`
  preserves design-specific nuance; the *floor* tags (identical every time) are pure win.
- **Quality guard:** the completeness gate + golden properties run on the HYDRATED graph
  (unchanged inputs downstream), and a golden test asserts hydrate(lean) ≡ the old
  full-node output for the dogfood designs, so we prove neutrality before shipping.

### 1.5 Blast radius

`NodeSchema`/wire schema (lean variant + hydrate), `ground.ts` prompt (teach lean
emission), a new KB file, `pipeline/hydrate.ts`, and the provider reconstruct. Cost /
completeness / TF / web are untouched (they consume full nodes). Est. ~1 focused day +
catalog authoring; risk mostly in the prompt teaching the model to emit lean reliably
(forced-tool schema enforces the *shape*; a few golden gens verify quality).

---

## 2. Layer B — Semantic memory / cache (the Redis story)  *(adopt behind our interfaces)*

What the Redis blog actually sells is a **retrieval reliability layer**: semantic (not
keyword) search, hybrid search, cross-session Agent Memory, and **LangCache — "recognizes
semantically similar queries and serves cached results instead of repeatedly calling the
model."** That LangCache line IS the owner's "capital of France → Paris instant recall."

**We already have this at DESIGN granularity, provider-abstracted (KTD5):**

- `ResponseCache` — exact prompt-hash → design ($0 repeat).
- `DesignVectorStore` (SQLite brute-force cosine) + learning-network **instant-serve** —
  a *near-match* prompt returns a stored design in ~1s/$0. This is our LangCache today.

**Where Redis genuinely fits — as BACKENDS behind those existing interfaces, not a rewrite:**

1. **`RedisVectorStore`** implementing `DesignVectorStore` — swap brute-force cosine for
   Redis Search vector when the corpus outgrows sub-ms brute force (~thousands of vectors).
2. **Semantic response cache** — today the exact-hash cache misses on "a URL shortener"
   vs "a link-shortening API". A Redis-vector semantic cache (cosine ≥ threshold → serve)
   widens instant-serve to *paraphrases*. **This is the biggest latency win for common
   prompts** — but it's a **recurrence play**: it does nothing for a novel design's decode.

**Honest limits (say them):** Redis does NOT make a first-of-its-kind design generate
faster — no clipboard for output tokens. It reduces *repeat/similar* latency and scales
retrieval. Adopt when (a) corpus retrieval stops being sub-ms, or (b) we want a semantic
(paraphrase-tolerant) prompt cache. Not required for Layer A, and not a launch blocker.

---

## 3. Reconciling the owner's framing (explicit)

- **"A hash that has all the data we need for a known service, not typing it fresh"** →
  **Layer A** (deterministic catalog). Cuts output every run. Build this.
- **"Paris is the capital of France → instant recall for the next asker"** → **Layer B**
  (semantic cache / Redis LangCache). We have it at design level; Redis is the scale/
  paraphrase upgrade behind our existing interface. Only helps on recurrence.
- Neither speeds the *irreducible* part: WHICH services, HOW they wire, the keyDecision
  rationale, the assumptions — that's the judgment we sell, and it's genuinely per-design.

## 4. Sequencing

1. **Layer A** — catalog + lean emission + hydrate + golden-neutrality test. The real,
   every-generation token cut; aligned with cost/security-floor extraction we already do.
2. **Layer B (semantic prompt cache)** — highest-value Redis piece; ships behind the
   existing `DesignVectorStore`/cache interfaces. Do after corpus growth makes it bite.
3. **Redis vector backend** — only when brute-force cosine stops being sub-ms.

## 5. Success criteria

- A: dogfood budget gen output ↓ ≥10% tokens with hydrate(lean) ≡ prior full-node graph
  on the golden set (zero completeness/gate regressions); `catalog_miss` telemetry live.
- B: a paraphrased prompt of an approved design instant-serves (cosine ≥ threshold) in
  ~1s/$0, measured, behind the unchanged store interface.
