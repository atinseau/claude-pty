// tests/errors.test.ts
import { test, expect } from "bun:test";
import { detectError } from "../src/errors";
import type { TranscriptEvent } from "../src/types";

// Helpers to build minimal TranscriptEvent objects
function makeAssistant(model: string, stop_reason: string | null): Extract<TranscriptEvent, { kind: "assistant" }> {
  return {
    kind: "assistant",
    model,
    content: [{ type: "text", text: "some text" }],
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason,
    timestamp: "2026-06-08T00:00:00Z",
    uuid: "test-uuid",
  };
}

// ─── Case 1: Normal end_turn → null (no error) ───────────────────────────────
test("normal end_turn returns null", () => {
  const events: TranscriptEvent[] = [makeAssistant("claude-opus-4-8", "end_turn")];
  const result = detectError(events, "❯ ");
  expect(result).toBeNull();
});

// ─── Case 2: Synthetic model → auth error verdict ────────────────────────────
test("last assistant model=<synthetic> → auth error verdict", () => {
  const events: TranscriptEvent[] = [makeAssistant("<synthetic>", "stop_sequence")];
  const result = detectError(events, "Invalid API key · Fix external API key");
  expect(result).not.toBeNull();
  expect(result!.isError).toBe(true);
  expect(result!.subtype).toBe("success"); // parity with -p: subtype "success" + is_error true
  expect(result!.apiErrorStatus).toBe(401);
});

// ─── Case 3: PTY text "Invalid API key" → auth verdict (even if no events) ───
test("pty 'Invalid API key' with empty events → auth error verdict", () => {
  const result = detectError([], "Invalid API key");
  expect(result).not.toBeNull();
  expect(result!.isError).toBe(true);
  expect(result!.subtype).toBe("success");
  expect(result!.apiErrorStatus).toBe(401);
});

// ─── Case 4: PTY text "Please run /login" → auth verdict ─────────────────────
test("pty 'Please run /login' → auth error verdict", () => {
  const result = detectError([], "Please run /login to authenticate");
  expect(result).not.toBeNull();
  expect(result!.isError).toBe(true);
  expect(result!.subtype).toBe("success");
  expect(result!.apiErrorStatus).toBe(401);
});

// ─── Case 5: PTY text "Reached maximum number of turns" → error_max_turns ────
test("pty 'Reached maximum number of turns' → error_max_turns verdict", () => {
  const events: TranscriptEvent[] = [makeAssistant("claude-opus-4-8", "tool_use")];
  const result = detectError(events, "Reached maximum number of turns (1)");
  expect(result).not.toBeNull();
  expect(result!.isError).toBe(true);
  expect(result!.subtype).toBe("error_max_turns");
  expect(result!.apiErrorStatus).toBeUndefined();
});

// ─── Case 6: PTY "Reached maximum number of turns" with empty events ─────────
test("pty max-turns message with no events → error_max_turns verdict", () => {
  const result = detectError([], "Reached maximum number of turns (5)");
  expect(result).not.toBeNull();
  expect(result!.isError).toBe(true);
  expect(result!.subtype).toBe("error_max_turns");
});

// ─── Case 7: Refusal (end_turn, real model) → null ────────────────────────────
test("refusal (end_turn, real model) returns null — not detectable", () => {
  const events: TranscriptEvent[] = [
    makeAssistant("claude-opus-4-8", "end_turn"),
  ];
  const result = detectError(events, "I can't help with that request.");
  expect(result).toBeNull();
});

// ─── Case 8: Auth error — synthetic model without PTY text ────────────────────
test("synthetic model alone (empty pty) → auth error verdict", () => {
  const events: TranscriptEvent[] = [makeAssistant("<synthetic>", "stop_sequence")];
  const result = detectError(events, "");
  expect(result).not.toBeNull();
  expect(result!.isError).toBe(true);
  expect(result!.subtype).toBe("success");
  expect(result!.apiErrorStatus).toBe(401);
});

// ─── Case 9: Empty events + empty pty → null ─────────────────────────────────
test("empty events and empty pty → null", () => {
  const result = detectError([], "");
  expect(result).toBeNull();
});

// ─── Case 10: Multiple assistants, last is real + end_turn → null ─────────────
test("multiple assistants, last end_turn real model → null", () => {
  const events: TranscriptEvent[] = [
    makeAssistant("claude-opus-4-8", "tool_use"),
    makeAssistant("claude-opus-4-8", "end_turn"),
  ];
  const result = detectError(events, "❯ ");
  expect(result).toBeNull();
});
