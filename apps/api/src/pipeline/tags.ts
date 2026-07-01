/**
 * Deterministic facet tagging of a generated design — the SAME "move correctness out
 * of model whim into code" pattern as the cost engine and the security floor. The
 * model never emits tags; they are derived from the structured body (services present,
 * tier, trade-offs), so tagging is free, instant, reproducible, and works retroactively
 * on the curated seeds. The service→facet map lives here as plain data so adding a
 * service is a one-line edit; a retag pass rewrites all stored tags when it changes.
 *
 * Facets are browse filters for the gallery, not a fine ontology: broad buckets
 * (compute, data, messaging, api, security, robustness, realtime, observability) that
 * a visitor scans quickly. A service may map to several facets (Kinesis = messaging +
 * realtime); a design's tags are the union over its tiers.
 */
interface TaggableDesign {
  recommendedTier?: string;
  tiers?: Array<{
    name?: string;
    summary?: string;
    nodes?: Array<{ awsService?: string; role?: string; security?: string[] }>;
    delta?: string[];
    tradeoffs?: string[];
  }>;
  assumptions?: string[];
  recommendationRationale?: string;
  keyDecisions?: Array<{ decision?: string; why?: string; alternatives?: string }>;
}

/**
 * Canonical lowercase service token -> facets. Keys are matched as substrings against
 * the normalized `awsService` string, so "Amazon API Gateway", "API Gateway", and
 * "apigateway" all resolve. Keys are specific enough that substring false-positives
 * across real AWS service names are negligible.
 */
export const SERVICE_CATEGORIES: Record<string, string[]> = {
  // Compute / hosting
  lambda: ["compute"],
  fargate: ["compute"],
  ecs: ["compute"],
  eks: ["compute"],
  ec2: ["compute"],
  "elastic beanstalk": ["compute"],
  "app runner": ["compute"],
  batch: ["compute"],
  lightsail: ["compute"],

  // Data / storage
  dynamodb: ["data"],
  rds: ["data"],
  aurora: ["data"],
  elasticache: ["data", "realtime"],
  redis: ["data", "realtime"],
  s3: ["data"],
  opensearch: ["data"],
  documentdb: ["data"],
  neptune: ["data"],
  timestream: ["data"],
  dax: ["data", "realtime"],
  efs: ["data"],
  "glacier": ["data"],

  // Messaging / async
  sns: ["messaging"],
  sqs: ["messaging"],
  eventbridge: ["messaging"],
  kinesis: ["messaging", "realtime"],
  "step functions": ["messaging"],
  msk: ["messaging", "realtime"],
  kafka: ["messaging", "realtime"],
  mq: ["messaging"],
  ses: ["messaging"],
  pinpoint: ["messaging"],
  firehose: ["messaging"],

  // API / edge
  "api gateway": ["api"],
  appsync: ["api"],
  cloudfront: ["api"],
  "load balancer": ["api"],
  "alb": ["api"],
  "nlb": ["api"],
  "route 53": ["api"],
  "lambda@edge": ["api", "compute"],

  // Security / identity
  kms: ["security"],
  waf: ["security"],
  shield: ["security"],
  guardduty: ["security"],
  "secrets manager": ["security"],
  "parameter store": ["security"],
  cognito: ["security"],
  "certificate manager": ["security"],
  acm: ["security"],
  macie: ["security"],
  inspector: ["security"],

  // Observability
  cloudwatch: ["observability"],
  "x-ray": ["observability"],
  cloudtrail: ["observability", "security"],

  // Realtime / streaming
  iot: ["realtime"],
  websocket: ["realtime"],
};

/** Signals in tier delta/tradeoff text that a design earns the `robustness` facet. */
const ROBUSTNESS_KEYWORDS = [
  "multi-az",
  "multi region",
  "multi-region",
  "failover",
  "fail-over",
  "disaster recovery",
  "read replica",
  "replica",
  "autoscal",
  "auto-scal",
  "standby",
  "high availability",
  "active-active",
  "active-passive",
];

/** The full facet vocabulary, in display order. */
export const FACETS = [
  "compute",
  "data",
  "messaging",
  "api",
  "realtime",
  "security",
  "robustness",
  "observability",
] as const;

/**
 * USE-CASE domains — the "what is this for" axis a visitor actually browses by
 * (e-commerce, chat, notifications…), orthogonal to the capability FACETS above
 * (compute, data…). The capability facets barely discriminate — almost every design
 * carries api+compute+data — so domains are the primary browse dimension in the gallery.
 *
 * Detection is deterministic keyword-matching over the design's own text (node roles,
 * tier summaries, key decisions, rationale) plus the original prompt when available.
 * A design may match several domains (a chat app with media uploads); it earns each it
 * hits. Keywords are specific enough that cross-domain false positives are rare; a
 * design that matches nothing gets no domain tag (the gallery just shows it under "all").
 */
export const DOMAINS = [
  "ecommerce",
  "chat",
  "notifications",
  "media",
  "webhooks",
  "iot",
  "data-pipeline",
  "static-site",
  "api-backend",
] as const;

/** Domain -> distinctive keyword signals matched (as substrings) against design text. */
const DOMAIN_KEYWORDS: Record<(typeof DOMAINS)[number], string[]> = {
  ecommerce: ["checkout", "shopping cart", "add to cart", "order processing", "order state", "fulfillment", "payment", "storefront", "product catalog", "inventory", "purchase"],
  chat: ["chat", "presence", "chat room", "direct message", "conversation", "message fan-out", "room fan-out"],
  notifications: ["notification", "push notification", "alert", "reminder", "fan-out to", "fanout", "email delivery", "sms", "pub/sub to subscribers"],
  media: ["thumbnail", "transcode", "transcoding", "image processing", "photo", "video upload", "video-upload", "media upload", "avatar", "encode video", "image upload"],
  webhooks: ["webhook", "callback url", "inbound event", "third-party event", "receive events from"],
  iot: ["iot", "telemetry", "sensor", "device ingest", "device data", "from devices"],
  "data-pipeline": ["etl", "batch job", "data export", "stream processing", "analytics pipeline", "ingestion pipeline", "data warehouse", "aggregation job", "audit event"],
  "static-site": ["static site", "landing page", "portfolio", "blog", "marketing site", "documentation site", "docs portal", "waitlist", "microsite", "single-page app", "spa dashboard", "view-count"],
  "api-backend": ["rest api", "graphql", "mobile backend", "json api", "saas api", "backend api", "url shortener", "feature flag", "to-do", "todo"],
};

/** The design's body text (node roles, summaries, decisions) as a lowercase haystack —
 *  the FALLBACK domain signal when no prompt is stored. Deliberately NOT the primary
 *  signal: a design body is full of ubiquitous ops/security plumbing (SNS alert topics,
 *  CloudWatch alarms, "event" fan-out) that false-matches notification/webhook keywords
 *  on almost every design. The prompt states the actual use-case; the body doesn't. */
function bodyDomainText(design: TaggableDesign): string {
  const parts: string[] = [];
  if (design.recommendationRationale) parts.push(design.recommendationRationale);
  for (const a of design.assumptions ?? []) parts.push(a);
  for (const k of design.keyDecisions ?? []) {
    if (k.decision) parts.push(k.decision);
    if (k.why) parts.push(k.why);
  }
  for (const tier of design.tiers ?? []) {
    if (tier.summary) parts.push(tier.summary);
    for (const n of tier.nodes ?? []) if (n.role) parts.push(n.role);
    for (const t of tier.tradeoffs ?? []) parts.push(t);
    for (const d of tier.delta ?? []) parts.push(d);
  }
  return parts.join(" ").toLowerCase();
}

/** The use-case domains a design matches — deterministic. Matches the PROMPT when we have
 *  it (the user's stated use-case, the clean signal), and only falls back to the noisy
 *  design body for legacy/prompt-less rows. */
export function domainTags(design: TaggableDesign, description?: string): string[] {
  const hay = description && description.trim() ? description.toLowerCase() : bodyDomainText(design);
  return DOMAINS.filter((dom) => DOMAIN_KEYWORDS[dom].some((kw) => hay.includes(kw)));
}

/** Strip vendor noise so "Amazon API Gateway" / "AWS Lambda" match their keys. */
function normalizeService(s: string): string {
  return s
    .toLowerCase()
    .replace(/\baws\b/g, "")
    .replace(/\bamazon\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive the tags for a design from its structured body: capability FACETS (from the
 * services present) plus use-case DOMAINS (from its text + the optional prompt). Pure
 * and defensive — a malformed/legacy body yields whatever it can, never throws. Returns
 * the sorted unique tag list (facets and domains share one array; the gallery renders
 * them as two filter rows off the same list).
 */
export function tagDesign(design: TaggableDesign, description?: string): string[] {
  const facets = new Set<string>();
  const robustText: string[] = [];
  let anyNodeSecurityTag = false;

  for (const tier of design.tiers ?? []) {
    for (const node of tier.nodes ?? []) {
      const svc = normalizeService(node.awsService ?? "");
      if (svc) {
        for (const [key, cats] of Object.entries(SERVICE_CATEGORIES)) {
          if (svc.includes(key)) cats.forEach((c) => facets.add(c));
        }
      }
      if ((node.security ?? []).length > 0) anyNodeSecurityTag = true;
    }
    for (const d of tier.delta ?? []) robustText.push(d.toLowerCase());
    for (const t of tier.tradeoffs ?? []) robustText.push(t.toLowerCase());
  }

  // Robustness: an opinionated resilient recommendation, or explicit HA language.
  if (
    design.recommendedTier === "resilient" ||
    robustText.some((t) => ROBUSTNESS_KEYWORDS.some((kw) => t.includes(kw)))
  ) {
    facets.add("robustness");
  }

  // Security: dedicated security services OR nodes carrying security control tags.
  if (facets.has("security") || anyNodeSecurityTag) facets.add("security");

  for (const dom of domainTags(design, description)) facets.add(dom);

  return Array.from(facets).sort();
}
