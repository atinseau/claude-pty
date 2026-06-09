// src/format/streamjson.ts
import type { ResultObject, TranscriptEvent } from "../types";

function assistantLine(
  sessionId: string,
  e: Extract<TranscriptEvent, { kind: "assistant" }>,
): string {
  return JSON.stringify({
    type: "assistant",
    session_id: sessionId,
    message: {
      role: "assistant",
      model: e.model,
      content: e.content,
      stop_reason: e.stop_reason,
      usage: e.usage,
    },
  });
}
function userLine(
  sessionId: string,
  e: Extract<TranscriptEvent, { kind: "user" }>,
): string {
  return JSON.stringify({
    type: "user",
    session_id: sessionId,
    message: { role: "user", content: e.content },
  });
}
function initLine(sessionId: string, model: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools: [],
  });
}

/**
 * Live emitter: buffers events until it can emit `system/init` carrying the model
 * (learned from the first assistant event), then flushes init + buffered events and
 * passes subsequent events straight through. Mirrors `claude -p` ordering (init first).
 */
export function createStreamJsonEmitter(sessionId: string) {
  let initEmitted = false;
  const buffered: TranscriptEvent[] = [];
  function lineFor(e: TranscriptEvent): string | null {
    if (e.kind === "assistant") return assistantLine(sessionId, e);
    if (e.kind === "user") return userLine(sessionId, e);
    return null;
  }
  function flushBuffered(model: string): string[] {
    const out = [initLine(sessionId, model)];
    initEmitted = true;
    for (const e of buffered) {
      const l = lineFor(e);
      if (l) out.push(l);
    }
    buffered.length = 0;
    return out;
  }
  return {
    onEvent(e: TranscriptEvent): string[] {
      if (initEmitted) {
        const l = lineFor(e);
        return l ? [l] : [];
      }
      if (e.kind === "assistant")
        return [...flushBuffered(e.model), assistantLine(sessionId, e)];
      buffered.push(e);
      return [];
    },
    flush(): string[] {
      if (initEmitted) return [];
      return flushBuffered("");
    },
    onResult(result: ResultObject): string {
      return JSON.stringify(result);
    },
  };
}
