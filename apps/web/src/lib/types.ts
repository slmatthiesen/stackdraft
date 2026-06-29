/**
 * Frontend mirror of the API's structured-architecture contract.
 *
 * SOURCE OF TRUTH: `apps/api/src/schema/architecture.ts` (Zod). These interfaces
 * are kept in sync MANUALLY for V1 — a shared `@drafture/schema` package that
 * both sides import is a later refactor. If you change the API schema, update
 * this file too (and the api client in `./api.ts`).
 */

export const TIER_NAMES = ["budget", "balanced", "resilient"] as const;
export type TierName = (typeof TIER_NAMES)[number];

export interface Node {
  id: string;
  awsService: string;
  /** Short label for what this node does (e.g. 'thumbnails') — enriches the diagram label. */
  role: string;
  security: string[];
}

export interface Edge {
  /** Source node id (or a synthetic endpoint like 'client'). */
  from: string;
  to: string;
  /** R4: the data/payload moving across this edge — every edge carries one. */
  payload: string;
  protocol: string;
}

export interface CostDriver {
  service: string;
  /** The service's NATIVE unit — 'per 1k requests' | '$/GB-month' | '$/hr' | '$/GB transferred' (R6). */
  unit: string;
  estimateRange: string;
  /** Clarifying note (e.g. 'required by private-subnet default'); empty string when none. */
  note: string;
  /** Instance class the server priced this $/hr line at (e.g. 't4g.small'); set only
   *  on instance-backed capacity drivers. The size-ladder uses it as the absolute-price
   *  baseline for a manual re-size (no ratio guessing → no double-apply). */
  instanceType?: string;
}

export interface Tier {
  name: TierName;
  summary: string;
  nodes: Node[];
  edges: Edge[];
  /** What this tier adds/changes versus the leaner tiers (R3). */
  delta: string[];
  costDrivers: CostDriver[];
  tradeoffs: string[];
}

/**
 * A staff-level architecture decision (ADR-style): the call that was made, what
 * was chosen, the alternatives weighed, and why. Surfaced in the KeyDecisions card.
 */
export interface KeyDecision {
  decision: string;
  chosen: string;
  alternativesConsidered: string[];
  rationale: string;
}

/** 200 response from `/api/generate` when a full design is produced. */
export interface GenerateResponse {
  /** Persisted-generation id (present when PERSIST_GENERATIONS is on) — the deep link. */
  id?: string;
  tiers: Tier[];
  assumptions: string[];
  /** The safe-by-default security floor — stated ONCE; applies to every tier (R7). */
  securityFloor: string[];
  /** The tier the architect leads with — auto-selected and badged in the UI. */
  recommendedTier: TierName;
  recommendationRationale: string;
  keyDecisions: KeyDecision[];
  /**
   * Present when the design was served instantly from the learning network (a near-
   * match to a design we've already shipped) instead of freshly generated. Drives the
   * "from our library" badge + the "generate fresh instead" option.
   */
  fromLibrary?: { basedOnPrompt: string; similarity: number };
}

/** 200 response from `/api/config` — an on-demand reference Terraform config. */
export interface ConfigResponse {
  format: string;
  code: string;
}

/** 200 response from `/api/generate` when the model needs more information (R2). */
export interface ClarifyResponse {
  needsClarification: true;
  questions: string[];
  round: number;
}

/** A curated gallery entry as listed by `GET /api/curated` (no design body). */
export interface CuratedSummary {
  id: string;
  title: string;
  prompt: string;
  /** One-line tech blurb (top services of the recommended tier) for the gallery card. */
  tech: string;
  upvotes: number;
  downvotes: number;
  createdAt: number;
}

/** A full curated run from `GET /api/curated/:id` — `design` renders like a fresh result. */
export interface CuratedRunFull extends Omit<CuratedSummary, "createdAt"> {
  design: GenerateResponse;
}

/**
 * A community-gallery card as listed by `GET /api/designs` (no design body). Mirrors
 * the API's `GenerationSummary`; the list endpoint also sends `status`/`updatedAt`,
 * which the gallery UI ignores. Sorted server-side by net community score.
 */
export interface DesignSummary {
  id: string;
  description: string;
  recommendedTier: TierName;
  tags: string[];
  upvotes: number;
  downvotes: number;
  genCount: number;
  model: string;
  createdAt: number;
}

/**
 * A deep-linkable design (`GET /api/designs/:id`) — the prompt plus a `design` body
 * that renders like a fresh result. The shape curated also normalizes to, so one
 * loader + one renderer serve both sources behind `/design/:id`.
 */
export interface DesignFull {
  id: string;
  prompt: string;
  design: GenerateResponse;
}
