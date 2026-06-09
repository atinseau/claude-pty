// src/tailer.ts
import { open } from "fs/promises";
import { parseLine } from "./transcript";
import type { TranscriptEvent } from "./types";

/** Parse complete (newline-delimited) JSONL text into events; blanks are ignored. */
export function parseLines(text: string): TranscriptEvent[] {
  if (!text) return [];
  return text
    .split("\n")
    .map(parseLine)
    .filter((e) => e.kind !== "ignored");
}

const NEWLINE = 0x0a;

/**
 * Incremental tail over a growing transcript file. Each poll(path) reads ONLY the
 * bytes appended since the last poll (tracked by byte offset) and returns the
 * events from lines that are now complete. A trailing partial line — or a partial
 * multi-byte UTF-8 sequence at the read boundary — is left unconsumed (the offset
 * stops at the last newline) and picked up on a later poll.
 *
 * This replaces re-reading + re-splitting the WHOLE file on every poll, which was
 * O(n²) over a long streamed response.
 */
export function makeTranscriptTail() {
  let offset = 0;
  return {
    async poll(path: string): Promise<TranscriptEvent[]> {
      let fd: Awaited<ReturnType<typeof open>>;
      try {
        fd = await open(path, "r");
      } catch {
        return []; // file not present yet
      }
      try {
        const { size } = await fd.stat();
        if (size <= offset) return [];
        const len = size - offset;
        const buf = Buffer.allocUnsafe(len);
        await fd.read(buf, 0, len, offset);
        const lastNl = buf.lastIndexOf(NEWLINE);
        if (lastNl < 0) return []; // no complete line yet — re-read next poll
        const complete = buf.subarray(0, lastNl + 1);
        offset += complete.length; // advance only past complete lines
        return parseLines(complete.toString("utf8"));
      } finally {
        await fd.close();
      }
    },
  };
}
