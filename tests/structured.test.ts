// tests/structured.test.ts
import { test, expect } from "bun:test";
import { extractStructuredOutput } from "../src/structured";
import { join } from "path";

const FIXTURES = join(import.meta.dir, "fixtures");

// Load the real fixture captured from a live --json-schema run
const fixtureText = await Bun.file(join(FIXTURES, "structured.jsonl")).text();

test("returns the structured object when attachment is present", () => {
  const result = extractStructuredOutput(fixtureText);
  expect(result).toBeDefined();
  expect(result).toEqual({ x: "hi" });
});

test("returns undefined when no structured_output attachment is present", () => {
  // transcript with no attachment lines
  const noAttachment = [
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"world"}],"stop_reason":"end_turn"}}',
  ].join("\n");
  expect(extractStructuredOutput(noAttachment)).toBeUndefined();
});

test("returns undefined for empty string", () => {
  expect(extractStructuredOutput("")).toBeUndefined();
});

test("returns undefined for whitespace-only string", () => {
  expect(extractStructuredOutput("   \n  \n  ")).toBeUndefined();
});

test("last structured_output attachment wins when multiple are present", () => {
  const twoAttachments = [
    '{"type":"attachment","attachment":{"type":"structured_output","data":{"x":"first"}}}',
    '{"type":"user","message":{}}',
    '{"type":"attachment","attachment":{"type":"structured_output","data":{"x":"last"}}}',
  ].join("\n");
  const result = extractStructuredOutput(twoAttachments);
  expect(result).toEqual({ x: "last" });
});

test("ignores non-structured_output attachment types", () => {
  const hookAttachment =
    '{"type":"attachment","attachment":{"type":"hook_success","data":{"foo":"bar"}}}';
  expect(extractStructuredOutput(hookAttachment)).toBeUndefined();
});

test("ignores non-JSON lines gracefully", () => {
  const mixed = [
    "not json at all",
    '{"type":"attachment","attachment":{"type":"structured_output","data":{"x":"ok"}}}',
    "also not json",
  ].join("\n");
  expect(extractStructuredOutput(mixed)).toEqual({ x: "ok" });
});
