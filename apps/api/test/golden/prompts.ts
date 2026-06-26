/**
 * Golden prompt set (U15/R16) — breadth, not depth.
 *
 * ~30 plain-language system descriptions spanning the four seeded reference
 * patterns (serverless / container / queue-async / static-site). The PROPERTY
 * assertions in properties.ts are universal (they hold for any valid design);
 * this set exists to exercise that breadth so a model/KB change is measured
 * across the workload, not a single happy path. `category` is breadth metadata
 * (not asserted); `expect` is optional per-prompt documentation — every golden
 * prompt is expected to satisfy every property.
 */
import type { PropertyName } from "./properties.js";

export type PromptCategory = "serverless" | "container" | "queue-async" | "static-site";

export interface GoldenPrompt {
  id: string;
  description: string;
  category: PromptCategory;
  /** Optional per-prompt expectations (all golden prompts expect all properties to pass). */
  expect?: Partial<Record<PropertyName, boolean>>;
}

export const GOLDEN_PROMPTS: readonly GoldenPrompt[] = [
  // --- Serverless API ------------------------------------------------------
  {
    id: "sl-saas-rest",
    description: "A serverless REST API on Lambda and DynamoDB for a small SaaS; bursty but low volume.",
    category: "serverless",
    expect: { everyTierCoversAllBaselines: true, allEdgesPayloadLabeled: true, exactlyThreeTiers: true },
  },
  {
    id: "sl-mobile-backend",
    description: "A JSON API backend for a mobile app: user accounts, profile data, and push notifications.",
    category: "serverless",
  },
  {
    id: "sl-todo-app",
    description: "A simple serverless to-do list API with login and per-user items.",
    category: "serverless",
  },
  {
    id: "sl-iot-ingest",
    description: "An API Gateway + Lambda endpoint ingesting small JSON telemetry events from IoT devices into DynamoDB.",
    category: "serverless",
  },
  {
    id: "sl-feature-flags",
    description: "A low-latency REST API serving feature-flag configuration to client apps, read-heavy.",
    category: "serverless",
  },
  {
    id: "sl-url-shortener",
    description: "A serverless URL shortener: create short links and redirect on lookup, high read volume.",
    category: "serverless",
  },
  {
    id: "sl-webhook-receiver",
    description: "A serverless API that receives third-party webhooks and stores normalized records.",
    category: "serverless",
  },

  // --- Container API -------------------------------------------------------
  {
    id: "ct-steady-api",
    description: "A containerized REST API with steady high traffic and long-running CPU-bound request handling on Fargate.",
    category: "container",
  },
  {
    id: "ct-legacy-migrate",
    description: "Migrate an existing Dockerized Node service with a relational database to AWS with managed scaling.",
    category: "container",
  },
  {
    id: "ct-graphql",
    description: "A GraphQL API server running in containers backed by a relational database and a cache.",
    category: "container",
  },
  {
    id: "ct-internal-tool",
    description: "An internal admin tool: a long-running container app behind a load balancer with Postgres.",
    category: "container",
  },
  {
    id: "ct-ml-inference",
    description: "A CPU-bound machine-learning inference service in containers with sustained throughput.",
    category: "container",
  },
  {
    id: "ct-ecommerce-api",
    description: "An e-commerce backend API on Fargate with RDS and ElastiCache for product catalog reads.",
    category: "container",
  },
  {
    id: "ct-websocket-chat",
    description: "A real-time chat backend with persistent connections running as a long-running container service.",
    category: "container",
  },

  // --- Queue-based async ---------------------------------------------------
  {
    id: "qa-image-pipeline",
    description: "A photo-upload app that processes images asynchronously after upload: thumbnails and metadata extraction.",
    category: "queue-async",
  },
  {
    id: "qa-email-notifications",
    description: "A system that sends email and SMS notifications in the background when events occur.",
    category: "queue-async",
  },
  {
    id: "qa-etl-batch",
    description: "An ETL pipeline that ingests files, transforms records in the background, and loads them into a datastore.",
    category: "queue-async",
  },
  {
    id: "qa-order-processing",
    description: "An order-processing system that decouples checkout from fulfillment using a queue with retries.",
    category: "queue-async",
  },
  {
    id: "qa-video-transcode",
    description: "A video-upload service that transcodes media asynchronously and notifies the user when done.",
    category: "queue-async",
  },
  {
    id: "qa-webhook-fanout",
    description: "Receive webhooks and fan them out to multiple downstream consumers asynchronously.",
    category: "queue-async",
  },
  {
    id: "qa-data-export",
    description: "A background job service that generates large CSV exports and stores them for later download.",
    category: "queue-async",
  },
  {
    id: "qa-audit-stream",
    description: "Buffer high-volume audit events through a queue and process them into a store with backpressure.",
    category: "queue-async",
  },

  // --- Static site + API ---------------------------------------------------
  {
    id: "ss-marketing-site",
    description: "A static marketing website with a small contact-form API behind it.",
    category: "static-site",
  },
  {
    id: "ss-spa-dashboard",
    description: "A single-page app dashboard served from the edge with a lightweight JSON API for data.",
    category: "static-site",
  },
  {
    id: "ss-blog",
    description: "A content-heavy blog served as a static site with a small comments API.",
    category: "static-site",
  },
  {
    id: "ss-docs-portal",
    description: "A documentation portal: static pages from the edge plus a search API endpoint.",
    category: "static-site",
  },
  {
    id: "ss-landing-waitlist",
    description: "A product landing page with a waitlist signup API that stores emails.",
    category: "static-site",
  },
  {
    id: "ss-portfolio",
    description: "A personal portfolio static site with a tiny dynamic view-counter API.",
    category: "static-site",
  },
  {
    id: "ss-event-microsite",
    description: "An event microsite served statically with an RSVP API and confirmation emails.",
    category: "static-site",
  },
];
