// tests/transcript.test.ts
import { test, expect } from "bun:test";
import { parseLine, parseTranscript } from "../src/transcript";

test("parseLine ignores meta/system lines", () => {
  expect(parseLine('{"type":"system","subtype":"bridge_status"}').kind).toBe("ignored");
  expect(parseLine('not json').kind).toBe("ignored");
  expect(parseLine('').kind).toBe("ignored");
});

test("parseLine extracts an assistant message", () => {
  const line = '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"x","timestamp":"2026-06-08T10:00:00.000Z"}';
  const ev = parseLine(line);
  expect(ev.kind).toBe("assistant");
  if (ev.kind !== "assistant") throw new Error("type");
  expect(ev.model).toBe("claude-opus-4-8");
  expect(ev.content[0]).toEqual({ type: "text", text: "hi" });
  expect(ev.usage.input_tokens).toBe(5);
  expect(ev.stop_reason).toBe("end_turn");
});

test("parseTranscript reads the fixture into 2 assistant + 2 user events", async () => {
  const text = await Bun.file("tests/fixtures/session.jsonl").text();
  const events = parseTranscript(text);
  expect(events.filter(e => e.kind === "assistant").length).toBe(2);
  expect(events.filter(e => e.kind === "user").length).toBe(2);
});
