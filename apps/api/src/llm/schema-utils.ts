/**
 * Provider-shared JSON-Schema prep for forced tool / function-calling.
 *
 * Both structured-output providers (Anthropic tool-use, GLM/OpenAI-compatible
 * function-calling) send the SAME resolved schema on the wire, so the model is
 * constrained identically regardless of provider. `architectureJsonSchema()` /
 * `clarificationJsonSchema()` emit a named schema; a tool `input_schema` / function
 * `parameters` field wants a top-level `{ type: "object", ... }`, so we resolve the
 * (here unused — `$refStrategy: "none"`) `$ref` wrapper and strip array
 * `minItems`/`maxItems` bounds some providers reject. The zod schema still
 * enforces `.length(3)` etc. when validating the response.
 */
import {
  addTierJsonSchema,
  architectureJsonSchema,
  budgetArchitectureJsonSchema,
  clarificationJsonSchema,
} from "../schema/architecture.js";

/** Fully-prepped JSON Schema for the architecture tool/function, cached per call. */
export function architectureToolSchema(): Record<string, unknown> {
  return resolveToolSchema(architectureJsonSchema());
}

/** Fully-prepped JSON Schema for the LAZY budget-only architecture tool/function. */
export function budgetArchitectureToolSchema(): Record<string, unknown> {
  return resolveToolSchema(budgetArchitectureJsonSchema());
}

/** Fully-prepped JSON Schema for the on-demand "+ Add tier" delta tool/function. */
export function addTierToolSchema(): Record<string, unknown> {
  return resolveToolSchema(addTierJsonSchema());
}

/** Fully-prepped JSON Schema for the clarification tool/function, cached per call. */
export function clarificationToolSchema(): Record<string, unknown> {
  return resolveToolSchema(clarificationJsonSchema());
}

function resolveToolSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const ref = jsonSchema["$ref"];
  const definitions = jsonSchema["definitions"];
  let schema = jsonSchema;
  if (typeof ref === "string" && definitions && typeof definitions === "object") {
    const name = ref.split("/").pop();
    if (name) {
      const inner = (definitions as Record<string, unknown>)[name];
      if (inner && typeof inner === "object") {
        schema = inner as Record<string, unknown>;
      }
    }
  }
  stripUnsupportedArrayBounds(schema);
  return schema;
}

/**
 * Some providers reject array `minItems`/`maxItems` other than 0/1 (a `.length(3)`
 * in zod emitted bounds that 400'd). Strip them from the SENT schema — zod keeps
 * the bounds and still validates the response, so the guarantee holds; only the
 * server-side hint is dropped (the system prompt already says "exactly three
 * tiers"). Mutates the freshly-generated schema in place.
 */
function stripUnsupportedArrayBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripUnsupportedArrayBounds(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of ["minItems", "maxItems"] as const) {
    const v = obj[key];
    if (typeof v === "number" && v !== 0 && v !== 1) delete obj[key];
  }
  for (const key of Object.keys(obj)) stripUnsupportedArrayBounds(obj[key]);
}
