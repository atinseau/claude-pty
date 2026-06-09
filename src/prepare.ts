// src/prepare.ts
//
// Shared request preparation used by BOTH execution paths (direct main() and the
// daemon). Given a parsed config + raw argv + stdin text + cwd, it finishes
// setting up the run: resolves stdin into the message (or NDJSON turns), resolves
// the session id, and snapshots pre-existing transcripts for --continue.
//
// Keeping this in one place is what guarantees the daemon behaves identically to
// a direct invocation.

import type { Config } from "./cli";
import { parseNdjsonMessages } from "./ndjson";
import type { SessionResolution } from "./session";
import { listTranscripts, resolveSessionId } from "./session";
import { combineMessage } from "./stdin";

export interface Prepared {
  sess: SessionResolution;
  ndjsonMessages: string[];
  preExisting: Set<string> | null;
}

/**
 * Finish preparing a run. Mutates `config.message` and `config.sessionId` in
 * place (as the original inline flow did). `stdinText` is the already-read stdin
 * (the daemon receives it in the request; direct mode reads it locally).
 */
export async function prepare(
  config: Config,
  argv: string[],
  stdinText: string,
  cwd: string,
): Promise<Prepared> {
  let ndjsonMessages: string[] = [];
  if (config.inputFormat === "stream-json") {
    ndjsonMessages = parseNdjsonMessages(stdinText);
    config.message = ""; // multi-turn: driver must NOT auto-inject
  } else {
    config.message = combineMessage(config.message, stdinText);
  }

  const sess = resolveSessionId(argv);
  config.sessionId = sess.sessionId ?? "";

  // --continue forks a NEW transcript file: snapshot before spawn so drive() can
  // detect the newly-appeared file to tail.
  const preExisting =
    sess.mode === "continue" ? new Set(await listTranscripts(cwd)) : null;

  return { sess, ndjsonMessages, preExisting };
}

/** Resolve the per-run hard deadline (ms) from an environment. */
export function turnTimeoutMs(env: NodeJS.ProcessEnv): number {
  return Number(env.CLAUDE_PTY_TURN_TIMEOUT_MS) || 600_000;
}
