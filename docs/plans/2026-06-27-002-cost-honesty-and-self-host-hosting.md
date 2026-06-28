# Cost-honesty roadmap + self-host hosting (TODO)

**Date:** 2026-06-27 · **Status:** 🚧 NOT YET IMPLEMENTED — roadmap
**Already done:** `2026-06-27-001-cost-capacity-scaling-fix.md` (capacity-scaling bug, ready to merge)
**Memory:** `drafture-cost-model-pricing-gaps.md`

Drafture still over-prices simple sites (its self-host design shows ~$150–200/mo vs the real ~$5–13
floor). The capacity-scaling bug is fixed (001). This is what remains.

## Remaining cost gaps
1. **Fixed mid-size seed pricing** (`packages/kb/pricing-facts.seed.json`). One price per service ⇒
   every node prices at a mid/large instance: `EC2 hour=$0.096` (m5.large → $70/mo), `RDS hour=$0.068`
   (db.t3.medium → $50/mo). Add a cheap-instance path so Budget can price a budget box: t4g.nano/micro
   EC2 (~$3–6/mo), t4g.micro RDS (~$12/mo), or instance-size selection.
   - **Framing fix:** RDS "$50" is a rented always-on database **SERVER** (compute hours), not
     storage — disk would be ~$2. Don't let the UI/label imply "storage".
2. **Service-matcher drops compute/DB lines.** `normalizeService` (`apps/api/src/pipeline/cost.ts:257`)
   is exact-match only, so model labels like "ECS Fargate task", "Aurora Serverless v2 (Postgres)",
   "SNS topic", "EventBridge Scheduler" don't hit the seed's canonical "Fargate"/"Aurora"/etc. →
   silently $0. Add a **keyword fallback** in `normalizeService` (label contains "Fargate" → "Fargate",
   etc.) + the missing seed entries (EBS, CloudWatch Dashboards/Alarms, Route 53).

## Tier reframe around EXPOSURE (so budget = the true floor)
Today every tier is a robustness variant of a Fargate-in-VPC design, so the NAT gateway is baked into
the floor. Reframe so public/private is a visible lever, not an invisible default:
- **budget** = serverless **or** single public-IP instance (Lightsail/EC2 + public IP, SQLite-on-disk
  or DynamoDB, nightly backup). **No NAT, no ALB, no Aurora.** ~$5–13/mo (or ~$0 serverless).
- **balanced** = private-subnet VPC (Fargate + NAT + ALB). The NAT appears **here as an explicit step
  up**, called out in the `delta` + a `keyDecision` ("private subnet → NAT gateway +~$33/mo").
- **resilient** = multi-AZ/region + managed DB.

Touches: the security floor (must **allow** a public-IP budget tier as a documented tradeoff rather
than forbid it), the system prompt's tier guidance, and the cost model's tier semantics. Every
load-bearing tier choice goes in `delta` + a `keyDecision`; public/private becomes a visible lever
(intake chip or a toggle on the result).

## Host Drafture on its own recommendation (decided)
Once the gaps + reframe land, regenerate the self-host example (`self-hosting-a-stateful-web-app`)
and host Drafture on **whatever honest tier it recommends.** If it lands on the always-on shape *and*
the other apps are dynamic services, amortize by consolidating them onto the same base (one
Lightsail/EC2 + Caddy reverse proxy for the public-IP shape; or the VPC if that's what's recommended).

**Datastore migration off SQLite → DynamoDB on-demand is viable** (the data model is NoSQL-shaped:
key-value + atomic counters, zero joins; the stores are already interface-abstracted). It enables
serverless / scale-to-zero if the recommendation goes that way. The work is **sync→async**
(better-sqlite3 is synchronous), not data modeling.

## Execution order
1. Commit/merge `fix/cost-topology-scaling` (001 — done).
2. Fix GAP 1 (seed pricing) + GAP 2 (matcher) in `cost.ts` + `pricing-facts.seed.json`.
3. Tier reframe: security floor, prompt, tier semantics.
4. Regenerate the self-host example; recompute curated costs.
5. Host Drafture per its own rec; consolidate other apps if it's the always-on shape.

## Coordination
`cost.ts` is hot — another agent has touched it; keep edits on isolated branches and reconcile. The
`generations-persistence` worktree owns store/scrub/tags — reconcile the `generations` store with any
datastore migration.
