// tests/format-streamjson-live.test.ts
import { expect, test } from "bun:test";
import type { ResultObject, TranscriptEvent } from "../../src/domain/types";
import { createStreamJsonEmitter } from "../../src/output/stream-json";

const userEv: TranscriptEvent = {
  kind: "user",
  content: [{ type: "text", text: "hi" }],
  timestamp: "t1",
  uuid: "u1",
};
const asstEv: TranscriptEvent = {
  kind: "assistant",
  model: "claude-opus-4-8",
  content: [{ type: "text", text: "yo" }],
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  stop_reason: "end_turn",
  timestamp: "t2",
  uuid: "a1",
};

test("init emitted once, before first event, with model from first assistant", () => {
  const em = createStreamJsonEmitter("sid");
  expect(em.onEvent(userEv).map((l) => JSON.parse(l))).toEqual([]);
  const afterAsst = em.onEvent(asstEv).map((l) => JSON.parse(l));
  expect(afterAsst[0]).toMatchObject({
    type: "system",
    subtype: "init",
    session_id: "sid",
    model: "claude-opus-4-8",
  });
  expect(afterAsst[1]).toMatchObject({ type: "user" });
  expect(afterAsst[2]).toMatchObject({ type: "assistant" });
  const more = em.onEvent(asstEv).map((l) => JSON.parse(l));
  expect(more.length).toBe(1);
  expect(more[0]).toMatchObject({ type: "assistant" });
});
test("flush() emits init even if no assistant event ever arrived", () => {
  const em = createStreamJsonEmitter("sid");
  em.onEvent(userEv);
  const flushed = em.flush().map((l) => JSON.parse(l));
  expect(flushed[0]).toMatchObject({
    type: "system",
    subtype: "init",
    model: "",
  });
  expect(flushed[1]).toMatchObject({ type: "user" });
});
test("initEarly emits init immediately and suppresses the later lazy init", () => {
  // Emitting init up-front (at TUI-ready) is what lets stream-json consumers see
  // a system/init line ~immediately instead of waiting for the first assistant.
  const em = createStreamJsonEmitter("sid");
  const early = em.initEarly("claude-opus-4-8").map((l) => JSON.parse(l));
  expect(early).toHaveLength(1);
  expect(early[0]).toMatchObject({
    type: "system",
    subtype: "init",
    session_id: "sid",
    model: "claude-opus-4-8",
  });
  // The user echo then flows straight through (no buffering, init already sent).
  expect(em.onEvent(userEv).map((l) => JSON.parse(l))).toEqual([
    expect.objectContaining({ type: "user" }),
  ]);
  // The first assistant event must NOT re-emit init.
  const afterAsst = em.onEvent(asstEv).map((l) => JSON.parse(l));
  expect(afterAsst).toEqual([expect.objectContaining({ type: "assistant" })]);
});

test("initEarly is idempotent — a second call emits nothing", () => {
  const em = createStreamJsonEmitter("sid");
  expect(em.initEarly("m").length).toBe(1);
  expect(em.initEarly("m")).toEqual([]);
});

test("onResult returns the stringified result line", () => {
  const em = createStreamJsonEmitter("sid");
  const result = { type: "result", subtype: "success" } as ResultObject;
  expect(JSON.parse(em.onResult(result))).toMatchObject({
    type: "result",
    subtype: "success",
  });
});
