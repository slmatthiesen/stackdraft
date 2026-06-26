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
export declare const GOLDEN_PROMPTS: readonly GoldenPrompt[];
