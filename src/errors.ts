// src/errors.ts
//
// Pure error-detection module. Infers the error verdict from transcript events
// and accumulated PTY text, since the JSONL transcript does NOT record
// `subtype`, `is_error`, `api_error_status`, or `terminal_reason`.
//
// Detection signals (from Spike A findings, verified 2026-06-08):
//
// AUTH (401):
//   - Last assistant event has model === "<synthetic>" (CLI injected a synthetic
//     message instead of a real API response)
//   - OR: PTY text matches /Invalid API key|Please run \/login/i
//   Real `claude -p` returns: subtype:"success", is_error:true, api_error_status:401
//   → We match that shape exactly for strict -p parity.
//
// MAX TURNS:
//   - PTY text matches /Reached maximum number of turns/i
//   Real `claude -p` returns: subtype:"error_max_turns", is_error:true
//   → We emit the same subtype.
//
// REFUSAL: NOT detectable — exits 0, subtype "success", end_turn, real model.
// Attempting to detect it would require content-level NLP; out of scope.

import type { TranscriptEvent } from "./types";

export interface ErrorVerdict {
  isError: boolean;
  subtype: string;
  apiErrorStatus?: number;
}

/**
 * Infer whether the session ended in an error state.
 *
 * @param events  Transcript events collected during the session.
 * @param ptyText Accumulated raw PTY output (the session snapshot).
 * @returns ErrorVerdict when an error is detected, null for clean success.
 */
export function detectError(events: TranscriptEvent[], ptyText: string): ErrorVerdict | null {
  // ── PTY text signals (checked before transcript, so they work even when
  //    events is empty — e.g. when auth fails before a transcript is written)

  // Max-turns check: PTY banner "Reached maximum number of turns"
  if (/Reached maximum number of turns/i.test(ptyText)) {
    return { isError: true, subtype: "error_max_turns" };
  }

  // Auth / API key error: PTY banner
  if (/Invalid API key|Please run \/login/i.test(ptyText)) {
    return { isError: true, subtype: "success", apiErrorStatus: 401 };
  }

  // ── Transcript signals (reliable when a transcript was written)

  const assistants = events.filter(
    (e): e is Extract<TranscriptEvent, { kind: "assistant" }> => e.kind === "assistant",
  );
  const last = assistants[assistants.length - 1];

  if (!last) return null;

  // Auth / API error: last assistant carries model "<synthetic>" — the CLI
  // injects a synthetic message when the real API call was never made.
  if (last.model === "<synthetic>") {
    return { isError: true, subtype: "success", apiErrorStatus: 401 };
  }

  // No error detected — normal success (or refusal, which is indistinguishable).
  return null;
}
