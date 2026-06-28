/**
 * Seed the curated example gallery (admin, offline).
 *
 * Runs a handful of showcase prompts through the SAME pipeline /api/generate uses
 * (generateArchitecture → deterministic estimateCosts) and stores each result as a
 * curated run. We call the pipeline directly rather than the HTTP route so seeding
 * bypasses the public friction chain (per-IP daily cap, Turnstile) and the clarify
 * gate — this is a trusted admin task, not a visitor request.
 *
 * COST: each prompt is a real model generation (~$0.10, ~90s on Sonnet). This spends
 * outside the $5/day request ceiling by design; keep the demo list short.
 *
 * Run:  pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx scripts/seedCurated.ts
 * Idempotent: re-running replaces each run's content by id but KEEPS accumulated votes.
 * Filter: set SEED_IDS=url-shortener,realtime-chat to re-seed only those demos (by slug);
 *         default re-seeds ALL demos. Use this to refresh specific designs without
 *         clobbering others (and without paying to regenerate the ones you want to keep).
 */
import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { generateArchitecture } from "../src/pipeline/generate.js";
import { estimateCosts } from "../src/pipeline/cost.js";

interface Demo {
  title: string;
  description: string;
  /** Intake answers in the UI's "<label>: <choice>" format (skips the clarify round). */
  answers: string[];
}

const DEMOS: Demo[] = [
  {
    title: "Photo-sharing app",
    description:
      "A photo-sharing app: users upload images, each processed asynchronously " +
      "(thumbnails, content moderation), and others see a feed. Uploads are bursty.",
    answers: [
      "Downtime tolerance: Important",
      "Data sensitivity: No",
    ],
  },
  {
    title: "URL shortener",
    description:
      "A URL shortener: a public API to create short links and a high-volume redirect " +
      "endpoint that looks up the target and 302s. Reads vastly outnumber writes.",
    answers: [
      "Downtime tolerance: Mission-critical",
      "Data sensitivity: No",
    ],
  },
  {
    title: "Realtime chat backend",
    description:
      "A realtime chat backend: persistent websocket connections, message fan-out to " +
      "rooms, message history persisted, and presence tracking.",
    answers: [
      "Downtime tolerance: Mission-critical",
      "Data sensitivity: No",
    ],
  },
  {
    title: "E-commerce checkout API",
    description:
      "An e-commerce checkout API: cart, order placement, payment via a third-party " +
      "processor, inventory decrement, and order-confirmation emails. Spiky at sale times.",
    answers: [
      "Downtime tolerance: Mission-critical",
      "Data sensitivity: Regulated (HIPAA/PCI/etc.)",
    ],
  },
  {
    title: "Notification system",
    description:
      "A notification system: it receives an inbound event via a webhook (a third party " +
      "POSTs to a public endpoint, or a client publishes directly), verifies the sender, " +
      "then fans the event out to subscribed destinations — transactional email, a mobile " +
      "push service, and a downstream webhook. Delivery must be reliable and observable " +
      "(retries with backoff, a dead-letter path, per-message delivery status), and inbound " +
      "volume is bursty.",
    answers: [
      "Downtime tolerance: Mission-critical",
      "Data sensitivity: No",
    ],
  },
  {
    title: "Self-hosting a stateful web app",
    description:
      "A public web tool (this site itself): a single Node.js process in one Docker " +
      "container runs a Fastify HTTP API that serves both a built static React SPA and " +
      "`/api/*` JSON endpoints on one port (8080). The API is stateful — for each request " +
      "it calls the Anthropic LLM over outbound HTTPS and writes to a database. The entire " +
      "datastore is ONE SQLite file (better-sqlite3, single-writer, on disk) holding a " +
      "memory cache, a response cache, a pricing cache, and a spend ledger; it must be " +
      "durable and backed up, and it cannot be served by multiple writers at once. LLM " +
      "calls are the dominant cost; the app self-limits them with per-IP rate limiting, a " +
      "per-IP daily cap, token caps, a 24h identical-response cache, and a hard global " +
      "daily-spend ceiling — so absolute compute need is small. It sits behind Cloudflare " +
      "(edge TLS, edge rate-limiting, optional Turnstile) and trusts CF-Connecting-IP; " +
      "there is no inbound database path. Traffic is low (a personal portfolio/showcase) " +
      "and bursty when shared. A monthly offline batch job streams large public pricing " +
      "files (hundreds of MB) to refresh a cache table, and must run off the request path. " +
      "The same footprint should also host several other small static web pages cheaply. " +
      "Optimize for low cost and simple ops while keeping the DB durable and the design " +
      "able to scale one step up without a rewrite.",
    answers: [
      "Downtime tolerance: Important",
      "Data sensitivity: No",
    ],
  },
];

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const config = getConfig();
  const ctx = buildAppContext(config);

  const seedIds = process.env.SEED_IDS?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const demos = seedIds ? DEMOS.filter((d) => seedIds.includes(slug(d.title))) : DEMOS;
  if (seedIds && demos.length === 0) {
    console.error(
      `SEED_IDS="${process.env.SEED_IDS}" matched no demos. Valid ids: ${DEMOS.map((d) => slug(d.title)).join(", ")}.`,
    );
    process.exit(1);
  }

  console.log(`Seeding ${demos.length} run${demos.length === 1 ? "" : "s"} with ${config.LLM_MODEL} (${config.DEFAULT_REGION})…`);
  for (const demo of demos) {
    const id = slug(demo.title);
    process.stdout.write(`  • ${demo.title} (${id})… `);
    try {
      const generated = await generateArchitecture({
        provider: ctx.provider,
        memory: ctx.stores.memory,
        description: demo.description,
        answers: demo.answers,
        opts: { maxTokens: config.LLM_MAX_TOKENS, effort: config.LLM_EFFORT },
      });
      const estimated = estimateCosts(generated.result, ctx.stores.pricing, config.DEFAULT_REGION);
      ctx.stores.curated.upsert({
        id,
        title: demo.title,
        prompt: demo.description,
        body: JSON.stringify(estimated),
      });
      console.log(`ok (recommends ${estimated.recommendedTier})`);
    } catch (err) {
      console.log(`FAILED`);
      console.error(err);
    }
  }

  ctx.db?.close();
  console.log("Done.");
}

void main();
