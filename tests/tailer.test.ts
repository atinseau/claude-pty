// tests/tailer.test.ts
import { expect, test } from "bun:test";
import { makeTranscriptCursor } from "../src/tailer";

test("cursor returns only newly-appended events on each consume()", () => {
  const cursor = makeTranscriptCursor();
  const l1 =
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"uuid":"u1","timestamp":"t1"}';
  const l2 =
    '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"yo"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"a1","timestamp":"t2"}';
  const first = cursor.consume(l1 + "\n");
  expect(first.map((e) => e.kind)).toEqual(["user"]);
  expect(cursor.consume(l1 + "\n")).toEqual([]);
  const second = cursor.consume(l1 + "\n" + l2 + "\n");
  expect(second.map((e) => e.kind)).toEqual(["assistant"]);
});

test("cursor ignores a trailing partial (unterminated) line until completed", () => {
  const cursor = makeTranscriptCursor();
  const full =
    '{"type":"user","message":{"role":"user","content":[]},"uuid":"u1","timestamp":"t1"}';
  expect(cursor.consume(full.slice(0, 20))).toEqual([]);
  expect(cursor.consume(full + "\n").map((e) => e.kind)).toEqual(["user"]);
});
