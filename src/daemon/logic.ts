// src/daemon-logic.ts
//
// Pure decision helpers for the daemon's warm/cold request handling, split out
// so the M3 pool logic is unit-testable without spawning a real TUI.

import type { SessionResolution } from "../store/locate";
import type { Warm } from "./pool";

/** The slice of WarmPool that takeLiveWarm needs. */
export interface TakeablePool<T> {
  take(sig: string): Warm<T> | null;
}

/**
 * Take the first LIVE warm entry for `sig`, killing any that died while idle —
 * handing out a dead TUI would hang the request until the turn timeout. Returns
 * null when none are available/live.
 */
export function takeLiveWarm<T extends { alive(): boolean }>(
  pool: TakeablePool<T>,
  sig: string,
): Warm<T> | null {
  let w = pool.take(sig);
  while (w && !w.value.alive()) {
    w.kill();
    w = pool.take(sig);
  }
  return w;
}

/**
 * Messages to inject when driving a warm TUI: the NDJSON turns in stream-json
 * input mode, otherwise the single combined text message.
 */
export function warmMessages(
  inputFormat: "text" | "stream-json",
  message: string,
  ndjsonMessages: string[],
): string[] {
  return inputFormat === "stream-json" ? ndjsonMessages : [message];
}

/**
 * The session resolution drive() should use for a warm TUI: its daemon-assigned
 * id, treated as explicit (so the transcript for that id is tailed).
 */
export function warmSess(sessionId: string): SessionResolution {
  return { sessionId, injectSessionId: false, mode: "explicit" };
}
