// src/tailer.ts
import { open } from "fs/promises";
import { parseObject } from "../domain/transcript";
import type { TranscriptEvent } from "../domain/types";

/** Decides whether a raw (JSON.parsed) transcript line belongs to this run — see domain/chain.ts. */
export type AdmitFilter = (raw: unknown) => boolean;

/**
 * Parse complete (newline-delimited) JSONL text into events; blanks and
 * malformed lines are ignored. `admit` (optional) sees each RAW parsed object
 * before event conversion and drops lines that belong to another run sharing
 * the transcript file.
 */
export function parseLines(
  text: string,
  admit?: AdmitFilter,
): TranscriptEvent[] {
  if (!text) return [];
  const out: TranscriptEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (admit && !admit(o)) continue;
    const e = parseObject(o);
    if (e.kind !== "ignored") out.push(e);
  }
  return out;
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
export function makeTranscriptTail(admit?: AdmitFilter) {
  let offset = 0;
  return {
    /**
     * Advance the offset past everything already on disk, so subsequent poll()s
     * return ONLY lines appended after this call. Used by --resume / --continue:
     * the transcript already holds the prior conversation (ending in a terminal
     * assistant message), and we must wait for THIS turn's fresh message instead
     * of mistaking the inherited one for completion. A missing file is a no-op
     * (offset stays 0, so the file is read from the start once it appears).
     */
    async prime(path: string): Promise<void> {
      try {
        const fd = await open(path, "r");
        try {
          offset = (await fd.stat()).size;
        } finally {
          await fd.close();
        }
      } catch {
        /* file not present yet — leave offset at 0 */
      }
    },
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
        return parseLines(complete.toString("utf8"), admit);
      } finally {
        await fd.close();
      }
    },
  };
}
