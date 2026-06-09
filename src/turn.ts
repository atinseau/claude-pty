// src/turn.ts
//
// Pure turn-completion predicates. The JSONL transcript is the source of truth
// (it carries each assistant message's stop_reason); the pty debounce is only a
// fallback for error states that never write a consumable transcript.

import type { TranscriptEvent } from "./types";

/**
 * True when the conversation's most recent assistant message ended the turn.
 *
 * A `stop_reason` of "tool_use" means the assistant is waiting on a tool (the
 * turn continues); `null` means the message is still streaming. Any other value
 * ("end_turn", "stop_sequence", "max_tokens", …) is terminal.
 */
export function isTerminal(events: TranscriptEvent[]): boolean {
  const assistants = events.filter(
    (e): e is Extract<TranscriptEvent, { kind: "assistant" }> =>
      e.kind === "assistant",
  );
  const last = assistants[assistants.length - 1];
  return !!last && last.stop_reason !== "tool_use" && last.stop_reason !== null;
}

/**
 * Decide whether the single-turn poll loop can stop.
 *
 * Fast path: as soon as the transcript shows a terminal turn we are done — the
 * final assistant message is already on disk, so there is no reason to also wait
 * out the pty's turn-done debounce (~800ms of pure latency per run).
 *
 * Fallback: when the transcript is still EMPTY, the only completion signal is
 * the pty returning to its prompt (`ptyDone`). This covers auth/API errors that
 * never write a consumable transcript — without it those runs would spin until
 * the turn deadline. We require an empty transcript so that a premature pty
 * signal mid-turn (e.g. a prompt flash during a tool denial) can never truncate
 * a turn whose final message has not yet been written.
 */
export function turnComplete(
  sawTerminal: boolean,
  ptyDone: boolean,
  eventCount: number,
): boolean {
  if (sawTerminal) return true;
  if (ptyDone && eventCount === 0) return true;
  return false;
}
