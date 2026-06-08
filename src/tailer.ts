// src/tailer.ts
import { parseLine } from "./transcript";
import type { TranscriptEvent } from "./types";

/**
 * Stateful cursor over the growing transcript TEXT. Each consume(fullText) returns
 * only the events from lines that are newly COMPLETE (newline-terminated) since the
 * previous call. A trailing line without a newline is treated as still being written
 * and is not emitted until it is completed.
 */
export function makeTranscriptCursor() {
  let emittedLines = 0;
  return {
    consume(fullText: string): TranscriptEvent[] {
      const lastNl = fullText.lastIndexOf("\n");
      if (lastNl < 0) return [];
      const complete = fullText.slice(0, lastNl).split("\n");
      if (complete.length <= emittedLines) return [];
      const fresh = complete.slice(emittedLines);
      emittedLines = complete.length;
      return fresh.map(parseLine).filter((e) => e.kind !== "ignored");
    },
  };
}
