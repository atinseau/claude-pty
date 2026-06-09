// tests/structured.test.ts
import { expect, test } from "bun:test";
import { extractJson, validateAgainstSchema } from "../src/structured";

// ─── extractJson ─────────────────────────────────────────────────────────────

test("extracts plain JSON object", () => {
  expect(extractJson('{"x":"hi"}')).toEqual({ x: "hi" });
});

test("extracts plain JSON array", () => {
  expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
});

test("extracts JSON from fenced code block (```json ... ```)", () => {
  const text = '```json\n{"x":"hi"}\n```';
  expect(extractJson(text)).toEqual({ x: "hi" });
});

test("extracts JSON from plain fenced code block (``` ... ```)", () => {
  const text = '```\n{"x":"hi"}\n```';
  expect(extractJson(text)).toEqual({ x: "hi" });
});

test("extracts JSON embedded in prose", () => {
  const text = 'Here is the result:\n{"x":"hi"}\nHope that helps!';
  expect(extractJson(text)).toEqual({ x: "hi" });
});

test("returns undefined for plain text with no JSON", () => {
  expect(extractJson("just some words")).toBeUndefined();
});

test("returns undefined for empty string", () => {
  expect(extractJson("")).toBeUndefined();
});

test("returns undefined for malformed JSON", () => {
  expect(extractJson("{not json}")).toBeUndefined();
});

test("handles nested objects", () => {
  const text = '{"a":{"b":1},"c":[1,2]}';
  expect(extractJson(text)).toEqual({ a: { b: 1 }, c: [1, 2] });
});

test("strips leading/trailing whitespace before parsing", () => {
  expect(extractJson('  \n  {"x":1}  \n  ')).toEqual({ x: 1 });
});

// ─── validateAgainstSchema ────────────────────────────────────────────────────

test("validates conforming object (required keys present, correct types)", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  };
  expect(validateAgainstSchema({ x: "hi" }, schema)).toBe(true);
});

test("rejects object missing required key", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  };
  expect(validateAgainstSchema({}, schema)).toBe(false);
});

test("rejects object with wrong type for property", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  };
  expect(validateAgainstSchema({ x: 42 }, schema)).toBe(false);
});

test("validates array when schema type is array", () => {
  const schema = { type: "array" };
  expect(validateAgainstSchema([1, 2], schema)).toBe(true);
});

test("rejects array when schema type is object", () => {
  const schema = { type: "object" };
  expect(validateAgainstSchema([1, 2], schema)).toBe(false);
});

test("validates string value", () => {
  const schema = { type: "string" };
  expect(validateAgainstSchema("hello", schema)).toBe(true);
});

test("rejects wrong top-level type (number vs string)", () => {
  const schema = { type: "string" };
  expect(validateAgainstSchema(42, schema)).toBe(false);
});

test("validates number value", () => {
  const schema = { type: "number" };
  expect(validateAgainstSchema(3.14, schema)).toBe(true);
});

test("validates boolean value", () => {
  const schema = { type: "boolean" };
  expect(validateAgainstSchema(true, schema)).toBe(true);
});

test("schema with no type constraint: any value passes", () => {
  expect(validateAgainstSchema({ anything: 1 }, {})).toBe(true);
});

test("object with extra properties beyond required: still valid", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  };
  expect(validateAgainstSchema({ x: "hi", y: 99 }, schema)).toBe(true);
});

// ─── integer vs number (JSON Schema distinguishes them; JS typeof does not) ───

test("integer type accepts a whole number", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
  };
  expect(validateAgainstSchema({ count: 3 }, schema)).toBe(true);
});

test("integer type rejects a non-whole number", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
  };
  expect(validateAgainstSchema({ count: 3.5 }, schema)).toBe(false);
});

test("number type accepts a float", () => {
  expect(
    validateAgainstSchema(
      { n: 3.5 },
      {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
    ),
  ).toBe(true);
});

test("top-level integer type matches", () => {
  expect(validateAgainstSchema(7, { type: "integer" })).toBe(true);
  expect(validateAgainstSchema(7.2, { type: "integer" })).toBe(false);
});
