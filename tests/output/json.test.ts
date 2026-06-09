// tests/format-json.test.ts
import { expect, test } from "bun:test";
import type { ResultObject } from "../../src/domain/types";
import { formatJson } from "../../src/output/json";

test("json format serializes the result object on one line", () => {
  const r: ResultObject = {
    type: "result",
    subtype: "success",
    result: "hi",
    session_id: "s1",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    duration_ms: 100,
    num_turns: 1,
    is_error: false,
    api_error_status: null,
    stop_reason: "end_turn",
    modelUsage: {},
    permission_denials: [],
    terminal_reason: "completed",
    uuid: "r-uuid",
    fast_mode_state: "off",
    duration_api_ms: null,
    ttft_ms: null,
    ttft_stream_ms: null,
    time_to_request_ms: null,
  };
  const out = formatJson(r);
  expect(out.endsWith("\n")).toBe(false);
  expect(JSON.parse(out)).toEqual(r);
});
