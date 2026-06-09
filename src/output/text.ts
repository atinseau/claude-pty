// src/format/text.ts
import type { TranscriptEvent } from "../domain/types";

export function formatText(events: TranscriptEvent[]): string {
  const assistants = events.filter((e) => e.kind === "assistant") as Extract<
    TranscriptEvent,
    { kind: "assistant" }
  >[];
  const last = assistants[assistants.length - 1];
  if (!last) return "";
  return last.content
    .filter((c) => c.type === "text")
    .map((c) => (c as any).text ?? "")
    .join("");
}
