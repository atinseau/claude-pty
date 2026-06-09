// tests/tailer.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeTranscriptTail, parseLines } from "../../src/store/tail";

const USER =
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"uuid":"u1","timestamp":"t1"}';
const ASST =
  '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"yo"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"a1","timestamp":"t2"}';

test("parseLines parses complete lines and ignores blanks", () => {
  expect(parseLines(`${USER}\n\n${ASST}\n`).map((e) => e.kind)).toEqual([
    "user",
    "assistant",
  ]);
  expect(parseLines("")).toEqual([]);
});

test("tail reads only newly-appended complete lines (incremental, by byte offset)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-tail-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, `${USER}\n`);
  const tail = makeTranscriptTail();

  expect((await tail.poll(path)).map((e) => e.kind)).toEqual(["user"]);
  // No new bytes → nothing.
  expect(await tail.poll(path)).toEqual([]);
  // Append a second line → only that one comes back.
  await appendFile(path, `${ASST}\n`);
  expect((await tail.poll(path)).map((e) => e.kind)).toEqual(["assistant"]);
});

test("tail holds a trailing partial (unterminated) line until its newline arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-tail-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, USER.slice(0, 20)); // partial, no newline
  const tail = makeTranscriptTail();
  expect(await tail.poll(path)).toEqual([]);
  await appendFile(path, `${USER.slice(20)}\n`);
  expect((await tail.poll(path)).map((e) => e.kind)).toEqual(["user"]);
});

test("tail handles multi-byte UTF-8 across the read boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-tail-"));
  const path = join(dir, "t.jsonl");
  const line = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"é→ok"}]},"uuid":"u","timestamp":"t"}`;
  const tail = makeTranscriptTail();
  writeFileSync(path, line); // multi-byte chars, no newline yet
  expect(await tail.poll(path)).toEqual([]);
  await appendFile(path, "\n");
  expect((await tail.poll(path)).map((e) => e.kind)).toEqual(["user"]);
});
