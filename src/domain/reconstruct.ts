// src/domain/reconstruct.ts
//
// Rebuild the `claude -p` result object from the JSONL transcript.
//
// KEY: a single API round-trip can be written as SEVERAL assistant lines that
// share one requestId and REPEAT the same usage (e.g. a `thinking` line and a
// `tool_use` line). `claude -p` counts round-trips and never double-counts that
// repeated usage — so we group assistants by requestId and take ONE per group.
// Transcripts without requestId fall back to one-group-per-line (see
// parseLine), preserving the previous behaviour.

import { modelMeta } from "./pricing";
import type {
  ModelUsage,
  ResultObject,
  ResultUsage,
  TranscriptEvent,
  Usage,
} from "./types";

type CostFn = (model: string, usage: Usage) => number;
type Assistant = Extract<TranscriptEvent, { kind: "assistant" }>;

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** One representative assistant message per requestId, in first-seen order. */
function dedupeByRequest(assistants: Assistant[]): Assistant[] {
  const byReq = new Map<string, Assistant>();
  for (const a of assistants) byReq.set(a.requestId, a); // last line of the group wins
  return [...byReq.values()];
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Sum a nested numeric sub-object (server_tool_use, cache_creation, …) across reps. */
function sumNested(reps: Assistant[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  let seen = false;
  for (const a of reps) {
    const nested = a.rawUsage[key];
    if (nested && typeof nested === "object") {
      seen = true;
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        out[k] = (out[k] ?? 0) + num(v);
      }
    }
  }
  return seen ? out : {};
}

/** Build the rich result `usage`: inherit the last turn's shape, override summed totals. */
function buildUsage(reps: Assistant[], totals: Usage): ResultUsage {
  const last = reps[reps.length - 1];
  const usage: ResultUsage = { ...(last?.rawUsage ?? {}), ...totals };
  const serverToolUse = sumNested(reps, "server_tool_use");
  if (Object.keys(serverToolUse).length) usage.server_tool_use = serverToolUse;
  const cacheCreation = sumNested(reps, "cache_creation");
  if (Object.keys(cacheCreation).length) usage.cache_creation = cacheCreation;
  return usage;
}

function buildModelUsage(
  reps: Assistant[],
  costFn: CostFn,
): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {};
  for (const a of reps) {
    const m = (out[a.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      ...modelMeta(a.model),
    });
    m.inputTokens += a.usage.input_tokens;
    m.outputTokens += a.usage.output_tokens;
    m.cacheReadInputTokens += a.usage.cache_read_input_tokens;
    m.cacheCreationInputTokens += a.usage.cache_creation_input_tokens;
    const stu = a.rawUsage.server_tool_use as
      | Record<string, unknown>
      | undefined;
    m.webSearchRequests += num(stu?.web_search_requests);
    m.costUSD += costFn(a.model, a.usage);
  }
  return out;
}

/**
 * A complete error ResultObject (used when no consumable transcript was written,
 * e.g. an auth failure). Carries the same `claude -p` parity field set as a
 * normal result so the two never diverge in shape.
 */
export function errorResult(opts: {
  subtype: string;
  sessionId: string;
  apiErrorStatus?: number;
  genUuid?: () => string;
}): ResultObject {
  const genUuid = opts.genUuid ?? (() => crypto.randomUUID());
  return {
    type: "result",
    subtype: opts.subtype,
    result: "",
    session_id: opts.sessionId,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    duration_ms: 0,
    num_turns: 0,
    is_error: true,
    api_error_status: opts.apiErrorStatus ?? null,
    stop_reason: null,
    modelUsage: {},
    permission_denials: [],
    terminal_reason: "error",
    uuid: genUuid(),
    fast_mode_state: "off",
    duration_api_ms: null,
    ttft_ms: null,
    ttft_stream_ms: null,
    time_to_request_ms: null,
  };
}

export function reconstruct(
  events: TranscriptEvent[],
  costFn: CostFn,
  sessionId: string,
  genUuid: () => string = () => crypto.randomUUID(),
): ResultObject {
  const assistants = events.filter(
    (e): e is Assistant => e.kind === "assistant",
  );
  // ONE representative per API round-trip — repeated per-requestId usage is
  // counted exactly once, matching `claude -p`.
  const reps = dedupeByRequest(assistants);

  const totals: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let cost = 0;
  for (const a of reps) {
    totals.input_tokens += a.usage.input_tokens;
    totals.output_tokens += a.usage.output_tokens;
    totals.cache_creation_input_tokens += a.usage.cache_creation_input_tokens;
    totals.cache_read_input_tokens += a.usage.cache_read_input_tokens;
    cost += costFn(a.model, a.usage);
  }

  const lastAssistant = assistants[assistants.length - 1];
  const result = lastAssistant ? textOf(lastAssistant.content as any) : "";

  const times = events
    .map((e) => (e.kind === "ignored" ? "" : e.timestamp))
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n));
  const duration_ms =
    times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;

  return {
    type: "result",
    subtype: "success",
    result,
    session_id: sessionId,
    total_cost_usd: cost,
    usage: buildUsage(reps, totals),
    duration_ms,
    num_turns: reps.length,
    is_error: false,
    api_error_status: null,
    stop_reason: lastAssistant?.stop_reason ?? null,
    modelUsage: buildModelUsage(reps, costFn),
    permission_denials: [],
    terminal_reason: "completed",
    uuid: genUuid(),
    fast_mode_state: "off",
    // Pure-timing telemetry the API engine measures; not in the transcript.
    duration_api_ms: null,
    ttft_ms: null,
    ttft_stream_ms: null,
    time_to_request_ms: null,
  };
}
