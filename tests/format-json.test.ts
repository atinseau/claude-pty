// tests/format-json.test.ts
import { test, expect } from "bun:test";
import { formatJson } from "../src/format/json";
import type { ResultObject } from "../src/types";

test("json format serializes the result object on one line", () => {
  const r: ResultObject = {
    type: "result", subtype: "success", result: "hi",
    session_id: "s1", total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    duration_ms: 100, num_turns: 1, is_error: false,
  };
  const out = formatJson(r);
  expect(out.endsWith("\n")).toBe(false);
  expect(JSON.parse(out)).toEqual(r);
});
