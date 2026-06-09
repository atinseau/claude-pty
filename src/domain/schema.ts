// src/structured.ts
//
// Pure utilities for JSON extraction and minimal schema validation.
//
// NOTE: validateAgainstSchema is intentionally a MINIMAL validator — it checks:
//   - top-level `type` (object/array/string/number/boolean)
//   - for objects: all `required` keys are present
//   - for objects: each present property roughly matches its declared `type`
// It is NOT a full JSON Schema validator (no $ref, allOf, anyOf, if/then,
// format, minimum/maximum, pattern, etc.). It is sufficient for the simple
// schemas used with --json-schema in practical claude-pty usage.

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) from `text`,
 * then find and parse the outermost { } or [ ] JSON value.
 *
 * Returns the parsed value or `undefined` if no valid JSON is found.
 */
export function extractJson(text: string): unknown | undefined {
  let s = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences (greedy-outermost).
  s = s.replace(/^```(?:json)?\s*([\s\S]*?)```\s*$/m, "$1").trim();

  // Find outermost { } or [ ] by scanning for the first { or [
  // then walking forward tracking depth to find its matching close.
  const firstBrace = s.indexOf("{");
  const firstBracket = s.indexOf("[");

  let start = -1;
  let open: string;
  let close: string;

  if (firstBrace === -1 && firstBracket === -1) return undefined;
  if (firstBrace === -1) {
    start = firstBracket;
    open = "[";
    close = "]";
  } else if (firstBracket === -1) {
    start = firstBrace;
    open = "{";
    close = "}";
  } else if (firstBrace < firstBracket) {
    start = firstBrace;
    open = "{";
    close = "}";
  } else {
    start = firstBracket;
    open = "[";
    close = "]";
  }

  // Walk forward tracking depth (respecting strings so braces inside strings
  // don't confuse the depth counter).
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return undefined;

  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Minimal JSON-Schema validator (NOT a full implementation — see module note).
 *
 * Checks:
 *   - top-level `type` matches
 *   - for object: all `required` array entries are present as keys
 *   - for object: each present property's value matches its `properties[key].type`
 */
export function validateAgainstSchema(value: unknown, schema: object): boolean {
  const s = schema as Record<string, unknown>;

  // No type constraint — anything passes.
  if (!("type" in s)) return true;

  const schemaType = s["type"] as string;

  // Helper: map JS runtime type to JSON Schema type name.
  function jsType(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v; // "string" | "number" | "boolean" | "object" | "bigint" etc.
  }

  // JSON Schema distinguishes "integer" from "number"; JS typeof reports both as
  // "number". Treat "integer" as a whole number, "number" as any number.
  function typeMatches(v: unknown, type: string): boolean {
    if (type === "integer") return typeof v === "number" && Number.isInteger(v);
    if (type === "number") return typeof v === "number";
    return jsType(v) === type;
  }

  if (!typeMatches(value, schemaType)) return false;

  // For objects, check required keys and property types.
  if (schemaType === "object" && value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const required = (s["required"] as string[] | undefined) ?? [];
    const properties =
      (s["properties"] as
        | Record<string, Record<string, unknown>>
        | undefined) ?? {};

    // All required keys must be present.
    for (const key of required) {
      if (!(key in obj)) return false;
    }

    // For each present property that has a declared type, check it.
    for (const key of Object.keys(obj)) {
      const propSchema = properties[key];
      if (propSchema && "type" in propSchema) {
        if (!typeMatches(obj[key], propSchema["type"] as string)) return false;
      }
    }
  }

  return true;
}
