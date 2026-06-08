// src/format/streamjson.ts
import type { TranscriptEvent, ResultObject } from "../types";

interface InitInfo { model: string; tools?: string[] }

export function formatStreamJson(
  events: TranscriptEvent[],
  result: ResultObject,
  init: InitInfo,
): string[] {
  const out: string[] = [];
  out.push(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: result.session_id,
    model: init.model,
    tools: init.tools ?? [],
  }));

  for (const e of events) {
    if (e.kind === "assistant") {
      out.push(JSON.stringify({
        type: "assistant",
        session_id: result.session_id,
        message: { role: "assistant", model: e.model, content: e.content, stop_reason: e.stop_reason, usage: e.usage },
      }));
    } else if (e.kind === "user") {
      out.push(JSON.stringify({
        type: "user",
        session_id: result.session_id,
        message: { role: "user", content: e.content },
      }));
    }
  }

  out.push(JSON.stringify(result));
  return out;
}
