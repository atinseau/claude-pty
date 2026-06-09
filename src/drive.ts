// src/drive.ts
//
// The core "drive a started session to a result" loop, extracted from main() so
// it can be shared verbatim by both execution paths:
//   • direct mode (main.ts) — Sink writes to process.stdout/stderr, returns the
//     exit code which main() passes to process.exit.
//   • daemon mode — Sink relays lines back over the IPC socket; the daemon kills
//     the (single-use) session afterwards.
//
// Behaviour is identical to the previous inline implementation: same loops, same
// stream-json early-init, same error handling, same output. The only difference
// is that output goes through `sink` and the exit code is RETURNED instead of
// calling process.exit(), and the session is NOT killed here (the caller owns
// the session lifecycle).

import { basename } from "path";
import type { Config } from "./cli";
import { modelFlag } from "./cli";
import type { Session } from "./driver";
import { detectError } from "./errors";
import { formatJson } from "./format/json";
import { createStreamJsonEmitter } from "./format/streamjson";
import { formatText } from "./format/text";
import { costOf } from "./pricing";
import { reconstruct } from "./reconstruct";
import {
  findTranscriptById,
  listTranscripts,
  type SessionResolution,
} from "./session";
import { extractJson, validateAgainstSchema } from "./structured";
import { makeTranscriptCursor } from "./tailer";
import { countTerminalTurns, isTerminal, turnComplete } from "./turn";
import type { TranscriptEvent } from "./types";

// Transcript poll cadence. Kept small so the final assistant line — and, in
// stream-json mode, each intermediate event — is picked up promptly once the
// transcript flushes; the files involved are tiny so the re-read cost is trivial.
const POLL_MS = 40;

/** Where drive() sends its output. Direct mode wires these to process streams. */
export interface Sink {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Everything drive() needs beyond the config + started session. */
export interface DriveDeps {
  sess: SessionResolution;
  /** Transcript files present before spawn (continue mode), else null. */
  preExisting: Set<string> | null;
  /** Messages to inject in multi-turn (stream-json input) mode; empty otherwise. */
  ndjsonMessages: string[];
  /** Reads the session's pty turn-done flag (set by the onTurnDone hook). */
  ptyDone: () => boolean;
  /** Working directory whose project transcripts to tail (the CLIENT's cwd). */
  cwd: string;
  /** Hard per-run deadline in ms (from CLAUDE_PTY_TURN_TIMEOUT_MS, default 600000). */
  turnTimeoutMs: number;
}

/**
 * Drive a started session to completion, writing output through `sink`.
 * Returns the process exit code (0 success, 1 error). Does not kill the session.
 */
export async function drive(
  config: Config,
  session: Session,
  deps: DriveDeps,
  sink: Sink,
): Promise<number> {
  const { sess, preExisting, ndjsonMessages } = deps;

  const cursor = makeTranscriptCursor();
  const collected: TranscriptEvent[] = [];
  let emitter: ReturnType<typeof createStreamJsonEmitter> | null = null;
  let effectiveId = sess.sessionId ?? "";

  async function locate(): Promise<string | null> {
    if (sess.sessionId) return findTranscriptById(sess.sessionId);
    const current = await listTranscripts(deps.cwd); // continue mode
    return current.find((f) => !preExisting!.has(f)) ?? null;
  }

  const deadline = Date.now() + deps.turnTimeoutMs;
  let path: string | null = null;
  let sawTerminal = false;

  // ─── stream-json: emit system/init up-front (A) ───────────────────────────
  const initModel = modelFlag(config.passthrough);
  function emitInitEarly(): void {
    if (config.outputFormat !== "stream-json" || !effectiveId) return;
    if (!emitter) emitter = createStreamJsonEmitter(effectiveId);
    for (const line of emitter.initEarly(initModel)) sink.out(line + "\n");
  }

  if (config.inputFormat === "stream-json") {
    // ─── Multi-turn: inject each message, drive turn completion from the
    // transcript (B), gating the next inject on promptBack().
    await session.ready;
    emitInitEarly();

    const drainTranscript = async () => {
      if (!path) {
        path = await locate();
        if (path) {
          effectiveId = basename(path).replace(/\.jsonl$/, "");
          emitInitEarly(); // --continue: id only known now
        }
      }
      if (path) {
        const text = await Bun.file(path).text();
        const fresh = cursor.consume(text);
        for (const e of fresh) {
          collected.push(e);
          if (config.outputFormat === "stream-json") {
            if (!emitter) emitter = createStreamJsonEmitter(effectiveId);
            for (const line of emitter.onEvent(e)) sink.out(line + "\n");
          }
        }
      }
    };

    let completed = 0;
    for (const msg of ndjsonMessages) {
      session.inject(msg);
      while (Date.now() < deadline) {
        await drainTranscript();
        if (countTerminalTurns(collected) > completed && session.promptBack())
          break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      completed++;
      if (Date.now() >= deadline) break;
    }
    sawTerminal = isTerminal(collected);
  } else {
    // ─── Single-turn path ─────────────────────────────────────────────────────
    await session.ready;
    emitInitEarly();
    while (Date.now() < deadline) {
      if (!path) {
        path = await locate();
        if (path) {
          effectiveId = basename(path).replace(/\.jsonl$/, "");
          emitInitEarly(); // --continue: id only known now
        }
      }
      if (path) {
        const text = await Bun.file(path).text();
        const fresh = cursor.consume(text);
        for (const e of fresh) {
          collected.push(e);
          if (config.outputFormat === "stream-json") {
            if (!emitter) emitter = createStreamJsonEmitter(effectiveId);
            for (const line of emitter.onEvent(e)) sink.out(line + "\n");
          }
        }
        sawTerminal = isTerminal(collected);
      }
      if (turnComplete(sawTerminal, deps.ptyDone(), collected.length)) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  // Kill the (single-use) session before formatting output, exactly as the
  // previous inline flow did — snapshot() reads the already-captured pty log.
  // kill() reaps the whole claude.exe tree (TUI + MCP/hook children) so nothing
  // is orphaned — critical under the long-lived, console-less daemon.
  session.kill();

  if (collected.length === 0) {
    // No consumable transcript: surface a faithful error result if the pty text
    // carries a recognisable banner (auth, etc.), matching `claude -p`'s shape.
    const earlyVerdict = detectError([], session.snapshot());
    if (earlyVerdict?.isError) {
      const errResult = {
        type: "result" as const,
        subtype: earlyVerdict.subtype,
        result: "",
        session_id: effectiveId || "",
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
        ...(earlyVerdict.apiErrorStatus !== undefined
          ? { api_error_status: earlyVerdict.apiErrorStatus }
          : {}),
      };
      if (config.outputFormat === "text") {
        sink.err(
          `error: ${earlyVerdict.subtype}${earlyVerdict.apiErrorStatus ? ` (${earlyVerdict.apiErrorStatus})` : ""}\n`,
        );
      } else if (config.outputFormat === "stream-json") {
        const em = createStreamJsonEmitter(effectiveId || "");
        for (const line of em.flush()) sink.out(line + "\n");
        sink.out(em.onResult(errResult) + "\n");
      } else {
        sink.out(formatJson(errResult) + "\n");
      }
      return 1;
    }
    sink.err(
      `transcript not found or empty for session ${effectiveId || "(unknown)"}\n`,
    );
    return 1;
  }

  const result = reconstruct(collected, costOf, effectiveId);

  // Error detection: override subtype/is_error from transcript/pty text for -p parity.
  const verdict = detectError(collected, session.snapshot());
  if (verdict?.isError) {
    result.is_error = true;
    result.subtype = verdict.subtype;
    if (verdict.apiErrorStatus !== undefined)
      result.api_error_status = verdict.apiErrorStatus;
  }

  // Structured output validation (--json-schema). On failure, match -p: is_error
  // true, subtype kept, structured_output omitted.
  if (config.jsonSchema) {
    const parsed = extractJson(formatText(collected));
    if (
      parsed !== undefined &&
      validateAgainstSchema(parsed, JSON.parse(config.jsonSchema))
    ) {
      result.structured_output = parsed;
    } else {
      result.is_error = true;
    }
  }

  if (config.outputFormat === "text") {
    sink.out(formatText(collected) + "\n");
  } else if (config.outputFormat === "json") {
    sink.out(formatJson(result) + "\n");
  } else {
    if (!emitter) emitter = createStreamJsonEmitter(effectiveId);
    for (const line of emitter.flush()) sink.out(line + "\n");
    sink.out(emitter.onResult(result) + "\n");
  }

  return result.is_error ? 1 : 0;
}
