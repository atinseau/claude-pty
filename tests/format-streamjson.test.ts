// tests/format-streamjson.test.ts
import { test, expect } from "bun:test";
import { parseTranscript } from "../src/transcript";
import { reconstruct } from "../src/reconstruct";
import { formatStreamJson } from "../src/format/streamjson";

test("stream-json emits init, one event per message, then result", async () => {
  const events = parseTranscript(await Bun.file("tests/fixtures/session.jsonl").text());
  const result = reconstruct(events, () => 0, "11111111-1111-1111-1111-111111111111");
  const lines = formatStreamJson(events, result, { model: "claude-opus-4-8" });

  const parsed = lines.map(l => JSON.parse(l));
  expect(parsed[0]).toMatchObject({ type: "system", subtype: "init", session_id: "11111111-1111-1111-1111-111111111111" });
  // Events preserve transcript order: user prompt, assistant, user tool_result, assistant.
  expect(parsed[1]).toMatchObject({ type: "user" });
  expect(parsed[2]).toMatchObject({ type: "assistant" });
  expect(parsed[parsed.length - 1]).toMatchObject({ type: "result", subtype: "success" });
  expect(parsed.length).toBe(6);
});
