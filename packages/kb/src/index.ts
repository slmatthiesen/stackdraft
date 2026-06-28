/**
 * @drafture/kb — seeded curated knowledge base (U4).
 *
 * Contracts only here; the JSON seed files are populated in U4 and loaded into
 * the stores on first boot. Each fact is citeable (source URL) so research-on-miss
 * (U6) can append in the exact same shape.
 */

export interface SecurityBaseline {
  id: string;
  rule: string;
  rationale: string;
  /** Short one-line floor statement, used as the deterministic securityFloor text. */
  summary: string;
  source: string;
}

/**
 * A curated, static glossary term surfaced as a hover tooltip in the UI (no LLM).
 * Deterministic product knowledge — version-controlled here, served read-only.
 */
export interface GlossaryTerm {
  /** The term as it appears in output text, e.g. "DLQ", "NAT Gateway". */
  term: string;
  /** A concise, plain-language definition (≤ ~2 sentences). */
  definition: string;
}

export interface ReferenceArchitecture {
  id: string;
  name: string;
  whenToUse: string;
  services: string[];
  burstMechanisms: string[];
  source: string;
}

export interface PricingFact {
  service: string;
  region: string;
  unit: string;
  usd: number;
  note: string;
  source: string;
}
