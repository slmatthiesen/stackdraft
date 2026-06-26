import type { ArchitectureResult } from "../../src/schema/architecture.js";
export type PropertyName = "exactlyThreeTiers" | "everyTierCoversAllBaselines" | "allEdgesPayloadLabeled" | "onDemandDisclaimerPresent" | "noBannedServices";
export interface PropertyResult {
    name: PropertyName;
    ok: boolean;
    /** Human-readable explanation; empty-ish on pass, specific on fail. */
    reason: string;
}
export type Property = (result: ArchitectureResult) => PropertyResult;
/**
 * R7 — every one of the three tiers must collectively reflect ALL eight security
 * baselines. Budget is the minimum *safe* cost, not a security-relaxed tier, so
 * a missing baseline on any tier is a hard fail.
 */
export declare const everyTierCoversAllBaselines: Property;
/** R4 — every edge in every tier carries a non-empty payload label. */
export declare const allEdgesPayloadLabeled: Property;
export declare const onDemandDisclaimerPresent: Property;
export declare const BANNED_SERVICES: readonly ["ec2-classic", "public s3 bucket", "0.0.0.0/0", "root access key", "http://"];
export declare const noBannedServices: Property;
/** R3 — exactly budget/balanced/resilient, no more, no fewer. */
export declare const exactlyThreeTiers: Property;
export declare const ALL_PROPERTIES: readonly Property[];
export interface AggregateResult {
    ok: boolean;
    results: PropertyResult[];
}
/** Run every property and aggregate; `ok` is true only if all pass. */
export declare function runAllProperties(result: ArchitectureResult): AggregateResult;
