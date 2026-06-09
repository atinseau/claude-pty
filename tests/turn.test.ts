// tests/turn.test.ts
import { describe, expect, test } from "bun:test";
import { isTerminal, turnComplete } from "../src/turn";
import type { TranscriptEvent } from "../src/types";

function assistant(stop_reason: string | null): TranscriptEvent {
  return {
    kind: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    stop_reason,
    timestamp: "2026-01-01T00:00:00Z",
    uuid: "u",
  };
}

describe("isTerminal", () => {
  test("true when last assistant ended the turn (end_turn)", () => {
    expect(isTerminal([assistant("end_turn")])).toBe(true);
  });

  test("false when last assistant is awaiting a tool (tool_use)", () => {
    expect(isTerminal([assistant("tool_use")])).toBe(false);
  });

  test("false when last assistant is still streaming (null stop_reason)", () => {
    expect(isTerminal([assistant(null)])).toBe(false);
  });

  test("false when there is no assistant event yet", () => {
    expect(isTerminal([])).toBe(false);
  });

  test("looks only at the LAST assistant (tool_use then end_turn = terminal)", () => {
    expect(isTerminal([assistant("tool_use"), assistant("end_turn")])).toBe(
      true,
    );
  });
});

describe("turnComplete", () => {
  test("completes immediately when the transcript shows a terminal turn", () => {
    // Fast path: no need to also wait for the pty debounce.
    expect(turnComplete(true, false, 3)).toBe(true);
  });

  test("does NOT complete on a premature pty signal while a turn is in progress", () => {
    // collected is non-empty (turn underway) but transcript not yet terminal:
    // a mid-turn ptyDone (e.g. prompt flash during a tool denial) must not break.
    expect(turnComplete(false, true, 3)).toBe(false);
  });

  test("completes on pty signal only when the transcript is empty (error fast-exit)", () => {
    // Auth/API errors write no consumable transcript; the pty returning to its
    // prompt is the only completion signal — break instead of waiting to deadline.
    expect(turnComplete(false, true, 0)).toBe(true);
  });

  test("does not complete while neither signal is ready", () => {
    expect(turnComplete(false, false, 0)).toBe(false);
    expect(turnComplete(false, false, 3)).toBe(false);
  });
});
