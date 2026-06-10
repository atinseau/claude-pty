// src/transcript.ts
import type { ContentBlock, TranscriptEvent, Usage } from "./types";

const IGNORED: TranscriptEvent = { kind: "ignored" };

function normalizeUsage(u: any): Usage {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
  };
}

export function parseLine(line: string): TranscriptEvent {
  if (!line.trim()) return IGNORED;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return IGNORED;
  }
  return parseObject(o);
}

/** parseLine over an already-JSON.parsed line object (lets callers that need the raw object — e.g. the turn-chain filter — parse once). */
export function parseObject(o: any): TranscriptEvent {
  const msg = o?.message;
  if (o?.type === "assistant" && msg) {
    return {
      kind: "assistant",
      model: msg.model ?? "",
      content: (msg.content ?? []) as ContentBlock[],
      usage: normalizeUsage(msg.usage),
      rawUsage: (msg.usage ?? {}) as Record<string, unknown>,
      // requestId groups the lines of one API round-trip (thinking + tool_use +
      // text can be separate lines that share it). Fall back to the message uuid
      // so a transcript without requestId still treats each line as its own turn.
      requestId: (o.requestId ?? o.uuid ?? "") as string,
      stop_reason: msg.stop_reason ?? null,
      timestamp: o.timestamp ?? "",
      uuid: o.uuid ?? "",
    };
  }
  if (o?.type === "user" && msg && Array.isArray(msg.content)) {
    return {
      kind: "user",
      content: msg.content as ContentBlock[],
      timestamp: o.timestamp ?? "",
      uuid: o.uuid ?? "",
    };
  }
  return IGNORED;
}

export function parseTranscript(text: string): TranscriptEvent[] {
  return text
    .split("\n")
    .map(parseLine)
    .filter((e) => e.kind !== "ignored");
}
