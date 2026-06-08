// src/reconstruct.ts
import type { TranscriptEvent, ResultObject, Usage } from "./types";

type CostFn = (model: string, usage: Usage) => number;

function textOf(content: { type: string; text?: string }[]): string {
  return content.filter(c => c.type === "text").map(c => c.text ?? "").join("");
}

export function reconstruct(
  events: TranscriptEvent[],
  costFn: CostFn,
  sessionId: string,
): ResultObject {
  const assistants = events.filter(e => e.kind === "assistant") as Extract<TranscriptEvent, { kind: "assistant" }>[];

  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let cost = 0;
  for (const a of assistants) {
    usage.input_tokens += a.usage.input_tokens;
    usage.output_tokens += a.usage.output_tokens;
    usage.cache_creation_input_tokens += a.usage.cache_creation_input_tokens;
    usage.cache_read_input_tokens += a.usage.cache_read_input_tokens;
    cost += costFn(a.model, a.usage);
  }

  const last = assistants[assistants.length - 1];
  const result = last ? textOf(last.content as any) : "";

  const times = events.map(e => (e.kind === "ignored" ? "" : e.timestamp)).filter(Boolean).map(t => Date.parse(t)).filter(n => !Number.isNaN(n));
  const duration_ms = times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;

  return {
    type: "result",
    subtype: "success",
    result,
    session_id: sessionId,
    total_cost_usd: cost,
    usage,
    duration_ms,
    num_turns: assistants.length,
    is_error: false,
  };
}
