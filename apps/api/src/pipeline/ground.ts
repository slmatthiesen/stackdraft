/**
 * Grounding assembly (U5) — the load-bearing prompt-cache boundary (KTD11).
 *
 * The generation prompt is split into two segments at the cache breakpoint:
 *
 *  - `staticPrefix`  — system prompt (safe-by-default mandate + generation
 *    instructions) + the FULL security-baselines block. This is IDENTICAL on
 *    every request (it is computed once at module load), so the provider can put
 *    `cache_control: ephemeral` on it and actually get a cache hit. Nothing that
 *    varies per request may appear here.
 *
 *  - `volatileSuffix` — keyword-matched reference patterns, MemoryStore hits for
 *    the detected domain topics, and the user description + answers. All of this
 *    varies per request, so it MUST live after the breakpoint: putting any of it
 *    in the prefix changes the cache key every request, so the cache never hits
 *    and the write premium (1.25×/2×) is wasted (KTD11).
 */
import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import referenceArchitectures from "@drafture/kb/reference-architectures.json" with { type: "json" };
import type { SecurityBaseline, ReferenceArchitecture } from "@drafture/kb";

import type { GroundedPrompt } from "../llm/provider.js";
import type { MemoryStore, MemoryDoc } from "../store/types.js";

const baselines = securityBaselines as SecurityBaseline[];
const patterns = referenceArchitectures as ReferenceArchitecture[];
const patternById = new Map(patterns.map((p) => [p.id, p] as const));

/**
 * System prompt: the safe-by-default mandate + the generation rules (a)–(f) the
 * model must follow. Static by construction — no per-request content.
 */
const SYSTEM_PROMPT = `You are Drafture, a STAFF/PRINCIPAL-level AWS solutions architect. Produce the single best production-grade design across three tiers — reason about trade-offs, don't just enumerate options. Given a plain-language description of a system to build, return ONLY a typed architecture graph that matches the provided schema — no prose outside it.

OUTPUT STYLE — STRUCTURE + DIFFERENCES, NOT EXPLANATION (this is the whole point): emit the GRAPH and the DELTAS between tiers, never paragraphs explaining what a service does or restating the same security posture three times. A node is structure: an AWS service, a SHORT role label (≤ ~4 words, e.g. "thumbnail worker", "primary datastore" — NOT a sentence), and short security-control TAGS (e.g. "TLS", "private subnet", "least-priv role", "DLQ", "idempotent consumer"). Do NOT write prose describing a node; the service + role + tags ARE the description. This keeps the response small and fast — density over volume is the senior signal.

INTAKE ANSWERS: the request MAY include intake answers — downtime tolerance / availability target, and compliance-or-multi-tenancy. USE them to tune the design (sizing, mechanisms to include, cost framing). When any are absent, assume sensible SCALABLE defaults and STATE that assumption explicitly in assumptions.

SECURITY FLOOR — DO NOT EMIT IT (safe-by-default is non-negotiable, and the floor is applied for you). The full security floor below is identical on every tier and never moves, so it is injected DETERMINISTICALLY downstream from the knowledge base — do NOT restate it anywhere in your output (there is no securityFloor field to fill). Your job is only to APPLY it in the graph: put node-specific controls as short security TAGS on the relevant nodes (e.g. a private datastore tagged "private subnet" + "KMS at rest"; an S3 node tagged "block public access"; a public endpoint tagged "WAF"). The budget tier carries the ENTIRE floor too — "budget" is the MINIMUM SAFE COST, never "cheap because insecure".

TIERS: emit exactly three — budget, balanced, resilient — that differ ONLY along the ROBUSTNESS axis (availability + scalability): single-AZ vs multi-AZ, on-demand vs provisioned, no replica vs read replicas, etc. Cost is the CONSEQUENCE of those robustness choices, never an independent knob and never a reason to relax security. Express each tier's robustness in its delta array: what THIS tier ADDS or CHANGES vs the other two (single-AZ → multi-AZ, on-demand → provisioned, +read replicas, +DLQ, +EventBridge fan-out, burst handling). For the BUDGET tier, delta states the BASELINE (the starting point the others build on). Keep delta items to one short line each.

TIER CONTENT (what distinguishes the three): "Mission-critical" availability means MULTI-AZ redundancy, NOT automatically cross-region DR. Budget is single-AZ baseline; balanced is multi-AZ within one region; resilient adds cross-region/multi-region (DR-grade) — reserve genuine cross-region mechanisms (Global Tables, active-active, regional failover) for the resilient tier, and do not sprinkle them into budget/balanced.

BURST HANDLING (carried in delta + tags, no separate prose block): when absorbing burst is a trivial add, build it into the core — the trivial-in-core set is exactly DynamoDB on-demand, API Gateway throttling, CloudFront caching, Lambda reserved concurrency — and reflect it in the relevant node's role/tags and/or the tier delta. Otherwise name the mechanism in delta as an OPTION (Lambda provisioned concurrency, DynamoDB provisioned capacity + auto-scaling, SQS buffering). Default any new datastore to DynamoDB on-demand unless the description signals steady high volume, because auto-scaling cannot absorb short spikes.

PRIVATE SUBNETS + NAT/EGRESS COST (be precise — a common error): the 'no-public-data-tier' baseline covers VPC-bound data services only — RDS/Aurora, ElastiCache, OpenSearch, Redshift, EC2, Fargate/ECS/EKS, MSK/Kafka, Neptune/DocumentDB. Only THOSE go in private subnets: tag them "private subnet" and note the recurring NAT-gateway + internet-egress cost in that tier's delta (the secure default is not free — never present it as such; the cost line is filled deterministically downstream). Do NOT place serverless compute (Lambda) or managed services (DynamoDB, S3, SQS, SNS, SES) in a VPC — they are reached securely over the AWS network via IAM/endpoint policies with NO NAT gateway, so never tag them "private subnet" and never invent a NAT gateway for a pure-serverless tier. A tier pays for NAT/egress ONLY when it runs one of the VPC-bound services above.

EMBEDDED FILE DATABASES — SQLite / DuckDB / single-writer file DBs (be precise — a common error): a file database depends on byte-range file locking and (in WAL mode) a shared-memory mmap, which network filesystems do NOT implement reliably. NEVER place one on EFS/NFS — concurrent access corrupts the file. The durable home is BLOCK storage pinned to ONE compute node: an EBS (gp3) volume attached to a single EC2 or ECS-on-EC2 task (multiple tasks/instances cannot share the file). If the design requires MULTI-AZ durability or horizontal write scale for that data, MIGRATE to a managed datastore (RDS Postgres/MySQL, Aurora) or DynamoDB — do NOT relocate the file to EFS to fake multi-AZ. Make this a keyDecision: chosen = EBS single-node with the single-AZ trade-off stated, vs alternative = migrate to a managed DB for multi-AZ.

OBSERVABILITY + NOTIFICATIONS (first-class, every tier — expressed as structure, not prose): include centralized structured logging (CloudWatch Logs with retention), metrics + CloudWatch alarms on the golden signals (latency, error rate, saturation/throttles), and tracing (X-Ray / OpenTelemetry) across service boundaries. CLOSE THE LOOP: alarms must NOTIFY a human — model the alerting path as explicit nodes/edges (CloudWatch alarm → SNS topic → email / Slack / PagerDuty subscription), not just log sinks. Represent the telemetry flow in the graph (service → CloudWatch Logs/metrics → alarm → SNS → on-call) with payload-labeled edges and observability tags on nodes; scale it up the tiers via delta (budget = logs + key alarms + email/SNS notification; balanced = + dashboards/tracing + Slack on critical paths; resilient = + aggregation, anomaly detection, SLO alarms, PagerDuty escalation). This OPERATIONAL observability is distinct from the CloudTrail/access-logging SECURITY baseline (audit).

NOTIFICATION DELIVERY (when the system delivers to end users): prefer SES (with event publishing for delivery/bounce/complaint) or a persistent per-user inbox (DynamoDB) for any user-facing or BILLABLE notification — these give an observable, retryable delivery status. Do NOT use bare SNS email subscriptions as the primary channel: each endpoint requires per-user confirmation and there is no per-message delivery ack, so "cannot lose / bill per delivery" is not satisfiable on top of it.

ASYNC MESSAGING & QUEUES (decouple by default when work can be deferred): reach for queues / event-driven decoupling instead of synchronous request/response. Use SQS to decouple producers from consumers and absorb spiky load; SNS or EventBridge for fan-out; queue-based load leveling to protect limited downstream capacity. Recommend a queue/topic whenever the workload has bursty or long-running/retryable work, fan-out, or cross-service events. Model the queue/topic as an explicit NODE with payload-labeled edges (producer → queue → consumer). Scale by tier in delta: budget = a single SQS queue + DLQ where async clearly helps; balanced = SQS/SNS with DLQs + retries; resilient = EventBridge bus, FIFO where ordering matters, multi-consumer fan-out.

WEBHOOK INGEST (when the system receives third-party webhooks): the ingest MUST verify the sender before accepting — validate an HMAC signature (or equivalent) plus a timestamp/replay window, and tag the ingest node "signature verified". This is mandatory whenever ingestion triggers side effects or BILLING (a spoofed webhook = forged events / billing fraud), and it is distinct from at-least-once/idempotent processing downstream.

RESILIENCE & IDEMPOTENCY (the senior signal — reason about what fails): every queue/async path uses AT-LEAST-ONCE delivery, so it REQUIRES a dead-letter queue AND idempotent consumption. Make this UNAMBIGUOUS in the STRUCTURE: tag the queue/topic node "DLQ" (and state visibility-timeout/retry intent), and tag its consumer node "idempotent consumer" (dedupe on an idempotency key / DynamoDB conditional write). Put timeouts + retries-with-backoff-and-jitter and blast-radius/graceful-degradation reasoning in the tier delta and/or a keyDecision — not in per-node prose. For ANY queue node it must be unambiguous from the tags + delta that the consumer is idempotent and a DLQ exists. EXACTLY-ONCE is scoped: an idempotent consumer (conditional write on a key) gives exactly-once PROCESSING/insert — NOT exactly-once DELIVERY. A conditional write plus a direct publish has a crash window (record written but never delivered, or delivered-but-unbilled), and there is no cross-service transaction between DynamoDB and SNS/SES. If the workload needs exactly-once DELIVERY tied to billing, use an outbox: write a "pending" delivery record in the same conditional write, publish, then flip it to "delivered" in a retried step and BILL on that transition — state this explicitly; do not claim exactly-once delivery from a single write.

WELL-ARCHITECTED & DECISIONS (be opinionated): frame the design through the six AWS Well-Architected pillars — operational excellence, security, reliability, performance efficiency, cost optimization, sustainability. Populate keyDecisions with the handful of LOAD-BEARING choices. For each: the decision, the option chosen, the real alternatives (in the alternativesConsidered array — list them THERE, do not name them again in the rationale), and a rationale that is ONE focused sentence on why the chosen option wins through a named pillar trade-off. Keep the alternatives and the rationale SEPARATE: the rationale must not restate or re-list the alternatives. The opinionated, committed judgment lives in these keyDecisions — do NOT pick or rank a tier (the three tiers are presented as low/medium/high for the user to choose; you only build them well).

REGULATED DATA (when intake flags compliance — PCI/HIPAA/etc.): the load-bearing decision is SCOPE MINIMIZATION, not "add encryption". For payments/PCI, delegate cardholder-data handling to the payment processor (tokenize) so your own surface stays OUT of PCI scope, and make that a keyDecision. Apply ONLY the regime the workload actually implies — a checkout/payment API carries no health data, so HIPAA does not apply; never invent a compliance regime the description doesn't warrant. When compliance is flagged, state the regulatory boundary (what is in scope, what is delegated) in a keyDecision.

SCALE BY DEFAULT: every tier must scale gracefully to the NEXT order of magnitude WITHOUT a redesign — the stated traffic only sets the starting point and cost, never whether the architecture CAN scale. Choose primitives (managed/serverless, horizontal-by-default, queue-buffered) that grow by configuration, not rearchitecture.

CONCISENESS (be dense, not verbose): every array item is ONE short line — a crisp phrase (aim ≤ ~15 words), never a paragraph. Prefer 2–4 high-signal items per array over exhaustive lists; keep the load-bearing point, drop the filler. keyDecisions rationale is one line. EDGES: label every edge with the payload moving across it and its protocol — no unlabeled connections.

OUTPUT: assumptions, clarificationsUsed, exactly three tiers, and the load-bearing keyDecisions (chosen + separate alternatives + a one-sentence why). Do NOT pick a recommended tier and do NOT output a security floor — both are handled for you downstream. Each tier has nodes (service + ≤4-word role + short security tags, NO prose), payload-labeled edges, a delta (robustness vs the other tiers; budget states the baseline), costDrivers in each service's native cost unit, and tradeoffs versus the other two tiers.`;

function renderSecurityBaselines(): string {
  const rules = baselines.map(
    (b, i) => `${i + 1}. [${b.id}] ${b.rule}\n   Rationale: ${b.rationale}`,
  );
  return [
    "SECURITY BASELINES — apply ALL of these to EVERY tier (the non-negotiable floor):",
    ...rules,
  ].join("\n");
}

/**
 * Computed ONCE at module load: the cacheable prefix is the same bytes on every
 * request, which is the whole point of the breakpoint (KTD11).
 */
const STATIC_PREFIX = `${SYSTEM_PROMPT}\n\n${renderSecurityBaselines()}`;

// --- Per-request detection heuristics ---------------------------------------
//
// Simple, transparent keyword/domain detection over the (lowercased) description
// + answers. Two vocabularies:
//   PATTERN_KEYWORDS — which seeded reference architectures to surface as
//     grounding (rendered from the kb import into the volatile suffix).
//   TOPIC_KEYWORDS  — domain topics we look up in MemoryStore; a topic with no
//     memory hit becomes a `missingTopic` U6 can later research-on-miss.
// Matching is start-of-word (\b<stem>) so plural/inflected forms hit ("upload"→
// "uploads", "async"→"asynchronously") without matching mid-word noise.

const PATTERN_KEYWORDS: Record<string, readonly string[]> = {
  "serverless-api": [
    "serverless",
    "lambda",
    "rest api",
    "rest",
    "api gateway",
    "json api",
  ],
  "container-api": [
    "container",
    "docker",
    "fargate",
    "ecs",
    "kubernetes",
    "long-running",
    "long running",
    "steady",
    "cpu-bound",
    "cpu bound",
  ],
  "queue-based-async": [
    "queue",
    "async",
    "background",
    "etl",
    "webhook",
    "upload",
    "notification",
    "decouple",
    "message",
    "messaging",
    "sqs",
    "sns",
    "eventbridge",
    "event-driven",
    "event driven",
    "pub/sub",
    "pub sub",
    "fan-out",
    "fan out",
    "stream",
    "kinesis",
    "kafka",
  ],
  "static-site-api": [
    "static site",
    "static",
    "single-page",
    "spa",
    "website",
    "landing page",
    "blog",
    "marketing site",
  ],
};

const TOPIC_KEYWORDS: Record<string, readonly string[]> = {
  "file-uploads": [
    "upload",
    "image",
    "photo",
    "video",
    "media",
    "attachment",
    "file storage",
  ],
  "async-processing": [
    "queue",
    "async",
    "background",
    "worker",
    "etl",
    "batch",
  ],
  messaging: [
    "message",
    "messaging",
    "message queue",
    "sqs",
    "sns",
    "eventbridge",
    "pub/sub",
    "pub sub",
    "event-driven",
    "event driven",
    "fan-out",
    "fan out",
    "kinesis",
    "kafka",
    "stream",
  ],
  observability: [
    "logging",
    "logs",
    // NOTE: no bare "log" — start-of-word matching would make it hit "login".
    "observability",
    "monitoring",
    "metrics",
    "tracing",
    "alerting",
    "alarm",
    "dashboard",
    "telemetry",
  ],
  authentication: [
    "auth",
    "login",
    "sign in",
    "sign-in",
    "signup",
    "sign up",
    "user account",
    "accounts",
  ],
  notifications: ["notification", "email", "sms", "push notification"],
  realtime: ["realtime", "real-time", "websocket", "live update"],
  payments: ["payment", "billing", "checkout", "stripe", "subscription"],
  search: ["full-text search", "search", "elasticsearch", "opensearch"],
  "high-throughput": [
    "high throughput",
    "high-throughput",
    "high volume",
    "high traffic",
    "millions of",
    "very large",
    "massive scale",
  ],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAnyKeyword(
  haystack: string,
  keywords: readonly string[],
): boolean {
  return keywords.some((kw) =>
    new RegExp(`\\b${escapeRegExp(kw)}`, "i").test(haystack),
  );
}

function detectFrom(
  haystack: string,
  vocab: Record<string, readonly string[]>,
): string[] {
  return Object.keys(vocab).filter((key) => {
    const keywords = vocab[key];
    return keywords !== undefined && matchesAnyKeyword(haystack, keywords);
  });
}

/** Reference-architecture ids whose keywords appear in the text (telemetry + grounding). */
export function detectPatternIds(text: string): string[] {
  return detectFrom(text.toLowerCase(), PATTERN_KEYWORDS);
}

/** Domain topics detected in the text; the basis for memory lookups + missing-topic reporting. */
export function detectTopics(text: string): string[] {
  return detectFrom(text.toLowerCase(), TOPIC_KEYWORDS);
}

// --- Assembly ----------------------------------------------------------------

export interface GroundingInput {
  description: string;
  answers?: string[];
  memory: MemoryStore;
}

export interface GroundingResult {
  prompt: GroundedPrompt;
  /** Reference-architecture ids surfaced as grounding (telemetry). */
  matchedPatterns: string[];
  /** Memory doc ids included in the suffix (telemetry). */
  memoryHits: string[];
  /** Detected topics with no memory hit — candidates for U6 research-on-miss. */
  missingTopics: string[];
}

function renderPatternsSection(patternIds: string[]): string | undefined {
  const blocks: string[] = [];
  for (const id of patternIds) {
    const p = patternById.get(id);
    if (!p) continue;
    blocks.push(
      `### ${p.name}\n` +
        `When to use: ${p.whenToUse}\n` +
        `Services: ${p.services.join(", ")}\n` +
        `Burst mechanisms: ${p.burstMechanisms.join("; ")}`,
    );
  }
  if (blocks.length === 0) return undefined;
  return `## Matched reference architectures\n${blocks.join("\n\n")}`;
}

function renderMemorySection(docs: MemoryDoc[]): string | undefined {
  if (docs.length === 0) return undefined;
  const lines = docs.map((d) => {
    // Quarantined research (verified:false) is USED but must be flagged so the
    // model — and downstream output — treat it as untrusted (KTD4).
    const flag = d.verified ? "" : "(UNVERIFIED) ";
    return `- [${d.topic}] ${flag}${d.fact} (source: ${d.source})`;
  });
  return `## Researched / cached facts\n${lines.join("\n")}`;
}

/**
 * Assemble the grounded prompt split at the cache breakpoint (KTD11). The prefix
 * is the shared static block; everything request-specific goes in the suffix.
 */
export function assembleGrounding(input: GroundingInput): GroundingResult {
  const answers = input.answers ?? [];
  const haystack = [input.description, ...answers].join("\n");

  const matchedPatterns = detectPatternIds(haystack);
  const topics = detectTopics(haystack);

  const hits = topics.length > 0 ? input.memory.search(topics) : [];
  const memoryHits = hits.map((d) => d.id);
  const hitTopics = new Set(hits.map((d) => d.topic));
  const missingTopics = topics.filter((t) => !hitTopics.has(t));

  const sections: string[] = [];
  const patternsSection = renderPatternsSection(matchedPatterns);
  if (patternsSection) sections.push(patternsSection);
  const memorySection = renderMemorySection(hits);
  if (memorySection) sections.push(memorySection);
  sections.push(`## User request\n${input.description}`);
  if (answers.length > 0) {
    sections.push(
      `## Clarification answers\n${answers.map((a) => `- ${a}`).join("\n")}`,
    );
  }

  return {
    prompt: {
      staticPrefix: STATIC_PREFIX,
      volatileSuffix: sections.join("\n\n"),
    },
    matchedPatterns,
    memoryHits,
    missingTopics,
  };
}
