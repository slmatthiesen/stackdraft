/**
 * Storage contracts (KTD5). V1 backs all four with one SQLite file; a Redis
 * implementation can drop in behind the same interfaces without changing
 * callers.
 */

/** A curated/researched best-practice fact (KB doc shape, U4/U6). */
export interface MemoryDoc {
  id: string;
  topic: string;
  fact: string;
  rationale: string;
  source: string;
  /** false = research-on-miss quarantine; surfaced as "unverified" until operator review (KTD4). */
  verified: boolean;
  provenance: "seed" | "research";
  createdAt: number;
  updatedAt: number;
}

export interface MemoryStore {
  upsert(doc: Omit<MemoryDoc, "createdAt" | "updatedAt"> & Partial<Pick<MemoryDoc, "createdAt" | "updatedAt">>): MemoryDoc;
  get(topic: string): MemoryDoc | undefined;
  getById(id: string): MemoryDoc | undefined;
  /** Topics with a verified or quarantined hit, used by grounding to detect misses. */
  search(topics: string[]): MemoryDoc[];
  listPending(): MemoryDoc[];
  setVerified(id: string, verified: boolean): boolean;
  delete(id: string): boolean;
}

export interface CachedResponse {
  promptHash: string;
  body: string;
  createdAt: number;
}

export interface ResponseCache {
  /** Returns undefined past TTL. */
  get(promptHash: string, ttlMs: number): CachedResponse | undefined;
  set(promptHash: string, body: string): void;
}

/** A normalized unit price keyed by (service, region) (KTD6). */
export interface PriceRecord {
  service: string;
  region: string;
  /** e.g. 'per-1k-requests', 'gb-month', 'hour', 'gb-transfer'. */
  unit: string;
  usd: number;
  month: string; // YYYY-MM snapshot this price belongs to
  note: string;
}

export interface PricingStore {
  get(service: string, region: string): PriceRecord[];
  /** Atomically replace one month's rows for a region (refresh job, U7). */
  replaceMonth(region: string, month: string, records: PriceRecord[]): void;
  /** Seed offline-fallback facts without clobbering a fresher month. */
  seed(records: PriceRecord[]): void;
}

/** Outcome of a reserve-on-entry spend check (KTD7). */
export interface SpendReservation {
  ok: boolean;
  /** Opaque id used to reconcile the provisional debit to actual usage. */
  reservationId: string;
  spentTodayUsd: number;
  ceilingUsd: number;
}

export interface SpendLedger {
  /**
   * Transactionally reserve a provisional debit at guard time. Concurrent callers
   * cannot each pass the ceiling check (no overshoot) — SQLite serializes writers.
   */
  reserve(provisionalUsd: number, ceilingUsd: number): SpendReservation;
  /** Reconcile a reservation to the actual cost once generation completes. */
  reconcile(reservationId: string, actualUsd: number): void;
  /** Release a reservation that never produced a charge (e.g. error). */
  release(reservationId: string): void;
  spentTodayUsd(): number;

  /** Per-IP daily generation counter for the per-IP cap (U8). */
  incrementIpCount(ip: string): number;
  ipCountToday(ip: string): number;
}
