# DRAFTURE — agent handoff brief (READ THIS FIRST)

> Source: regenerated from this pack's `prompt.txt` + `answers.json` through the improved
> Drafture pipeline (tier-delta + wire-up rules + 13-property completeness gate, gate PASS
> 13/13) · model claude-sonnet-4-6 · tier: **budget** · region: us-east-1 · 2026-06-29
> Siblings in this pack: `budget.tf` (reference Terraform), `design.json` (full design body).

This pack is an **agent-ready build plan**, not a finished stack. Drafture did the
judgment-heavy first 80% (architecture, sizing, security floor, cost). Your job is the
last 20%: turn `budget.tf` into something that `terraform plan`s cleanly and fits the
real repo. **Read every section below before touching the `.tf` — several omissions are
intentional decisions, not bugs.**

---

## 1. What the user actually asked for

> "I make future trades via TradingView alerts. I want to monitor those trades, display
> them in a graph + table for myself and the public. **I already have all of that built
> and hosted.** For right now I just need an endpoint that receives trades from
> TradingView and pushes that data where it needs to go. Later: an AI step that downloads
> trade data and runs Python evaluations on whether the trades were ideal."

Intake: downtime = best-effort · data sensitivity = none · traffic = <1k/mo.

**MVP scope (this pack):** TradingView webhook ingest → durable queue → async Python AI
eval → trade + eval-result store. Idle cost ~$0 (all serverless, no VPC/NAT).

## 2. Intentional scope decisions — DO NOT re-add without asking

These were deliberate. If you "helpfully" add them back, you undo a call the user made.

- **No UI/dashboard hosting.** The user already has the front end built and hosted
  elsewhere. Do **not** provision S3+CloudFront static hosting for a dashboard. The
  CloudFront in `budget.tf` fronts the **ingest API**, not a static site.
- **The existing frontend is fed by a PUSH fan-out, not a read API.** This design wires
  `ingest_lambda → SQS → dispatch_lambda → HTTP POST` to the user's existing frontend
  endpoint (see the `sqs_fanout`/`dispatch_lambda` nodes). The assumption — **confirm it
  with the user** — is that the already-built frontend exposes an ingest endpoint and owns
  its own display store. **⚠ Open gap to verify:** if the frontend instead expects to
  *pull* trades, there is no public GET route over DynamoDB here (IAM grants are
  `PutItem`/`UpdateItem` write-only) — in that case raise it and add either a read Lambda +
  `GET /trades` route or an AppSync endpoint. Do **not** silently assume the push lands
  somewhere usable; **confirm the frontend's ingest contract** (URL, auth, payload) first.
- **AI eval is async.** The webhook returns ~200ms; eval runs from the queue. Do not make
  eval synchronous with the webhook response.
- **No compliance regime.** No PII / regulated data → no HIPAA/PCI scope. Don't invent one.

## 3. Security floor (non-negotiable — preserve all of these)

TLS everywhere (terminate HTTPS at CloudFront) · KMS/SSE at rest (DynamoDB SSE, S3 SSE,
KMS-backed CloudWatch Logs) · least-privilege IAM per service, no wildcards · S3 Block
Public Access on every bucket · CloudFront + WAF (managed rules + rate-based) in front of
the public endpoint · CloudTrail audit trail. `budget.tf` already models these — keep them
when you refactor.

## 4. What you MUST do to make `budget.tf` apply-ready

This `budget.tf` is now emitted by the **deterministic Terraform emitter** (from the typed
graph, not an LLM), so the infra-wiring gaps are structurally closed: the API Gateway
`auto_deploy` stage, the CloudFront-logs S3 delivery ACL, and the KMS-key-policy grants for
CloudWatch Logs are all emitted alongside the resources that need them. Reference-only still
— the remaining work the agent owns is **application code and adoption**, not infra wiring:

- **No real Lambda handlers.** The Lambdas point at placeholder zips that don't exist.
  Supply real Python handlers: `ingest` (validate the **shared-secret bearer token** from
  the `Authorization` header against Secrets Manager — TradingView cannot HMAC-sign its
  webhooks, so a passphrase/bearer token is the auth, not a signature — then idempotent
  `PutItem` to DynamoDB on alert-id and `SendMessage` to the fan-out queue), `dispatch`
  (consume the queue, HTTP POST to the existing frontend endpoint, fail to the DLQ),
  `streams`-stub (DynamoDB Streams → S3 archive for the future AI eval). **Token
  validation is handler logic — it is NOT in the `.tf`; do not ship the endpoint without
  it**, and reject mismatches before any side-effect.
- **Adopt, don't recreate, anything that already exists.** If the user already has the
  table/buckets/hosting, `terraform import` them before applying — a naive `apply` will
  attempt to *create* and either fail or replace. Read the plan for `+ create` vs
  `~ change` on resources the user mentioned.

## 5. Hard rules

1. **Never auto-`apply`.** Run `terraform plan`, read the full diff (especially any
   `- destroy` or `->` replace), surface it to the user, and let them approve.
2. **Set an AWS billing budget** before any apply.
3. Region is us-east-1 unless the user says otherwise.
4. If a resource the user depends on appears as `replace/destroy` in the plan, **stop and
   ask** — that's data-loss risk.
