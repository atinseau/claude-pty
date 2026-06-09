// tests/reconstruct.test.ts
import { expect, test } from "bun:test";
import { reconstruct } from "../../src/domain/reconstruct";
import { parseTranscript } from "../../src/domain/transcript";

const costFn = (_m: string, u: any) =>
  (u.input_tokens + u.output_tokens) / 1000;

test("reconstruct builds the -p result object from the fixture", async () => {
  const events = parseTranscript(
    await Bun.file("tests/fixtures/session.jsonl").text(),
  );
  const r = reconstruct(events, costFn, "11111111-1111-1111-1111-111111111111");

  expect(r.type).toBe("result");
  expect(r.subtype).toBe("success");
  expect(r.result).toBe("The file says: hello from foo");
  expect(r.session_id).toBe("11111111-1111-1111-1111-111111111111");
  expect(r.num_turns).toBe(2);
  expect(r.usage.input_tokens).toBe(250);
  expect(r.usage.output_tokens).toBe(30);
  expect(r.duration_ms).toBe(3000);
  expect(r.total_cost_usd).toBeCloseTo(0.28, 5);
  expect(r.is_error).toBe(false);
});

// A tool turn writes thinking + tool_use as TWO assistant lines that share ONE
// requestId and repeat the SAME usage, then a final answer under a second
// requestId. claude -p counts API round-trips and never double-counts the
// repeated usage — so we group by requestId.
function assistantLine(
  reqId: string,
  block: object,
  stop: string,
  usage: object,
  model = "claude-opus-4-8[1m]",
): string {
  return JSON.stringify({
    type: "assistant",
    requestId: reqId,
    message: { model, content: [block], stop_reason: stop, usage },
    uuid: `${reqId}-${stop}`,
    timestamp: "2026-06-09T10:00:00.000Z",
  });
}

const TOOL_TURN = [
  assistantLine("req_A", { type: "thinking", thinking: "hmm" }, "tool_use", {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 10,
  }),
  assistantLine(
    "req_A",
    { type: "tool_use", id: "t1", name: "Bash", input: {} },
    "tool_use",
    {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 10,
    },
  ),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
    uuid: "u-tr",
    timestamp: "2026-06-09T10:00:01.000Z",
  }),
  assistantLine("req_B", { type: "text", text: "It printed ok." }, "end_turn", {
    input_tokens: 5,
    output_tokens: 10,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 0,
  }),
].join("\n");

test("num_turns counts distinct requestIds, not assistant messages", () => {
  const r = reconstruct(parseTranscript(TOOL_TURN), costFn, "sid");
  expect(r.num_turns).toBe(2); // req_A + req_B (the thinking/tool_use pair is ONE turn)
});

test("usage dedupes the repeated per-requestId usage (no double count)", () => {
  const r = reconstruct(parseTranscript(TOOL_TURN), costFn, "sid");
  // req_A counted once (100/50) + req_B (5/10) — NOT 100+100+5.
  expect(r.usage.input_tokens).toBe(105);
  expect(r.usage.output_tokens).toBe(60);
  expect(r.usage.cache_read_input_tokens).toBe(500);
});

test("total_cost_usd also dedupes per requestId", () => {
  const r = reconstruct(parseTranscript(TOOL_TURN), costFn, "sid");
  // (100+50)/1000 + (5+10)/1000 = 0.165 — not the double-counted 0.315.
  expect(r.total_cost_usd).toBeCloseTo(0.165, 6);
});

test("stop_reason is the final assistant's stop_reason", () => {
  const r = reconstruct(parseTranscript(TOOL_TURN), costFn, "sid");
  expect(r.stop_reason).toBe("end_turn");
});

test("adds -p parity scalar fields on success", () => {
  const r = reconstruct(parseTranscript(TOOL_TURN), costFn, "sid");
  expect(r.terminal_reason).toBe("completed");
  expect(r.permission_denials).toEqual([]);
  expect(r.api_error_status).toBeNull();
  expect(typeof r.uuid).toBe("string");
  expect(r.uuid.length).toBeGreaterThan(0);
});

test("modelUsage aggregates per model (deduped by requestId)", () => {
  const r = reconstruct(parseTranscript(TOOL_TURN), costFn, "sid");
  const mu = r.modelUsage["claude-opus-4-8[1m]"]!;
  expect(mu).toBeDefined();
  expect(mu.inputTokens).toBe(105);
  expect(mu.outputTokens).toBe(60);
  expect(mu.cacheReadInputTokens).toBe(500);
  expect(mu.costUSD).toBeCloseTo(0.165, 6);
  // verified static metadata for this model
  expect(mu.contextWindow).toBe(1_000_000);
  expect(mu.maxOutputTokens).toBe(64_000);
});
