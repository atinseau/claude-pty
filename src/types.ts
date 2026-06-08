// src/types.ts
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

export type TranscriptEvent =
  | {
      kind: "assistant";
      model: string;
      content: ContentBlock[];
      usage: Usage;
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
  usage: Usage;
  duration_ms: number;
  num_turns: number;
  is_error: boolean;
}
