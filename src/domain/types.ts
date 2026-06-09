// src/types.ts
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * The result `usage` object: the rich shape `claude -p` emits (server_tool_use,
 * service_tier, cache_creation breakdown, iterations, speed, …). We inherit
 * whatever the transcript's message.usage carried and override the summable
 * token totals — so the four core counts are guaranteed numbers and any extra
 * fields the CLI writes are passed through verbatim.
 */
export interface ResultUsage extends Usage {
  [k: string]: unknown;
}

/** Per-model usage breakdown (`modelUsage` in `claude -p`'s result). */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  /** Static model metadata — only emitted for models whose values we have verified. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    };

export type TranscriptEvent =
  | {
      kind: "assistant";
      model: string;
      content: ContentBlock[];
      usage: Usage;
      /** The original, un-normalized message.usage object (rich shape), for the result. */
      rawUsage: Record<string, unknown>;
      /** The API request this message belongs to; multiple lines can share one. */
      requestId: string;
      stop_reason: string | null;
      timestamp: string;
      uuid: string;
    }
  | { kind: "user"; content: ContentBlock[]; timestamp: string; uuid: string }
  | { kind: "ignored" };

export interface ResultObject {
  type: "result";
  subtype: string;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: ResultUsage;
  duration_ms: number;
  num_turns: number;
  is_error: boolean;
  /** null on success; the HTTP status when is_error is an API-level error (e.g. 401). Matches `claude -p`. */
  api_error_status: number | null;
  /** The final assistant message's stop_reason ("end_turn", "max_tokens", …). */
  stop_reason: string | null;
  /** Per-model usage/cost breakdown. */
  modelUsage: Record<string, ModelUsage>;
  /** Tools denied during the run (empty when tools were allowed / skip-permissions). */
  permission_denials: unknown[];
  /** How the run terminated ("completed", "max_turns", "error"). */
  terminal_reason: string;
  /** A uuid for this result record (fresh per run; matches `claude -p`'s shape, not its value). */
  uuid: string;
  /** Fast-mode state; "off" unless fast mode is detected. */
  fast_mode_state: string;
  /**
   * Pure-timing telemetry `claude -p` measures inside the API engine. NOT present
   * in the transcript, so we cannot reproduce the values — emitted as null for
   * shape parity rather than fabricated numbers.
   */
  duration_api_ms: number | null;
  ttft_ms: number | null;
  ttft_stream_ms: number | null;
  time_to_request_ms: number | null;
  /** Present when `--json-schema` is used. The validated structured object extracted from the transcript attachment. */
  structured_output?: unknown;
}
