// src/main.ts

import { basename } from "path";
import { helpText, modelFlag, parseArgs } from "./cli";
import { startSession } from "./driver";
import { detectError } from "./errors";
import { formatJson } from "./format/json";
import { createStreamJsonEmitter } from "./format/streamjson";
import { formatText } from "./format/text";
import { parseNdjsonMessages } from "./ndjson";
import { costOf } from "./pricing";
import { reconstruct } from "./reconstruct";
import {
  findTranscriptById,
  listTranscripts,
  resolveSessionId,
} from "./session";
import { combineMessage, readStdin } from "./stdin";
import { extractJson, validateAgainstSchema } from "./structured";
import { makeTranscriptCursor } from "./tailer";
import { countTerminalTurns, isTerminal, turnComplete } from "./turn";
import type { TranscriptEvent } from "./types";

const TURN_TIMEOUT_MS =
  Number(process.env.CLAUDE_PTY_TURN_TIMEOUT_MS) || 600_000;
// Transcript poll cadence. Kept small so the final assistant line — and, in
// stream-json mode, each intermediate event — is picked up promptly once the
// transcript flushes; the files involved are tiny so the re-read cost is trivial.
const POLL_MS = 40;

async function main() {
  const argv = Bun.argv.slice(2);
  let config: ReturnType<typeof parseArgs>;
  try {
    config = parseArgs(argv);
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(2);
  }

  // --help / -h: print usage to stdout and exit 0 without driving the TUI.
  if (config.help) {
    process.stdout.write(helpText());
    process.exit(0);
  }

  const stdinText = await readStdin();

  // In stream-json input mode, stdin is NDJSON messages — do NOT combine with positional message.
  // In text mode, combine positional + stdin text as before.
  let ndjsonMessages: string[] = [];
  if (config.inputFormat === "stream-json") {
    ndjsonMessages = parseNdjsonMessages(stdinText);
    config.message = ""; // multi-turn mode: driver must NOT auto-inject
  } else {
    config.message = combineMessage(config.message, stdinText);
  }

  const sess = resolveSessionId(argv);
  // Single source of truth for the id the driver injects (fixes double-generation).
  config.sessionId = sess.sessionId ?? "";

  // --continue always forks a NEW transcript file (Spike C): snapshot before spawn
  // so we can detect the newly-appeared file to tail.
  const preExisting =
    sess.mode === "continue"
      ? new Set(await listTranscripts(process.cwd()))
      : null;

  const cursor = makeTranscriptCursor();
  const collected: TranscriptEvent[] = [];
  let emitter: ReturnType<typeof createStreamJsonEmitter> | null = null;
  let effectiveId = sess.sessionId ?? "";

  let ptyDone = false;
  const session = startSession(config, {
    onTurnDone: () => {
      ptyDone = true;
    },
  });

  async function locate(): Promise<string | null> {
    if (sess.sessionId) return findTranscriptById(sess.sessionId);
    const current = await listTranscripts(process.cwd()); // continue mode
    return current.find((f) => !preExisting!.has(f)) ?? null;
  }

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let path: string | null = null;
  let sawTerminal = false;

  // ─── stream-json: emit system/init up-front (A) ───────────────────────────
  // Emit init as soon as the session id is known, so consumers see the session
  // start ~immediately instead of waiting for the first assistant event. The
  // model comes from --model when pinned, else "". In --continue mode the id is
  // unknown until the transcript is located, so we defer to the lazy init then.
  const initModel = modelFlag(config.passthrough);
  function emitInitEarly(): void {
    if (config.outputFormat !== "stream-json" || !effectiveId) return;
    if (!emitter) emitter = createStreamJsonEmitter(effectiveId);
    for (const line of emitter.initEarly(initModel))
      process.stdout.write(line + "\n");
  }

  if (config.inputFormat === "stream-json") {
    // ─── Multi-turn: inject each message, then drive turn completion from the
    // transcript (B). For each turn we wait until the transcript shows one more
    // terminal assistant message AND the pty prompt has returned (promptBack) —
    // no 800ms debounce. Gating the next inject on promptBack keeps keystrokes
    // from landing before the input box is ready.
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
            for (const line of emitter.onEvent(e))
              process.stdout.write(line + "\n");
          }
        }
      }
    };

    let completed = 0;
    for (const msg of ndjsonMessages) {
      session.inject(msg);
      while (Date.now() < deadline) {
        await drainTranscript();
        // This turn is done once its terminal assistant is on disk AND the
        // prompt has returned (so the next inject won't be swallowed).
        if (countTerminalTurns(collected) > completed && session.promptBack())
          break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      completed++;
      if (Date.now() >= deadline) break;
    }
    sawTerminal = isTerminal(collected);
  } else {
    // ─── Single-turn path ───────────────────────────────────────────────────────
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
            for (const line of emitter.onEvent(e))
              process.stdout.write(line + "\n");
          }
        }
        sawTerminal = isTerminal(collected);
      }
      // Transcript-driven completion: stop as soon as the transcript shows a
      // terminal turn (no need to also wait out the pty debounce). ptyDone is
      // kept as a fallback only when the transcript is empty (error states).
      if (turnComplete(sawTerminal, ptyDone, collected.length)) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  session.pty.kill();

  if (collected.length === 0) {
    // Before giving up with a plain error message, check whether the PTY output
    // contains a recognisable error banner (e.g. "Invalid API key").  If so,
    // emit a faithful minimal error result object so the caller gets the same
    // shape as a real `claude -p` error response, then exit 1.
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
        // text mode: just signal the error on stderr
        process.stderr.write(
          `error: ${earlyVerdict.subtype}${earlyVerdict.apiErrorStatus ? ` (${earlyVerdict.apiErrorStatus})` : ""}\n`,
        );
      } else if (config.outputFormat === "stream-json") {
        // stream-json: emit system/init before the result, matching -p's ordering.
        const em = createStreamJsonEmitter(effectiveId || "");
        for (const line of em.flush()) process.stdout.write(line + "\n");
        process.stdout.write(em.onResult(errResult) + "\n");
      } else {
        process.stdout.write(formatJson(errResult) + "\n");
      }
      process.exit(1);
    }
    process.stderr.write(
      `transcript not found or empty for session ${effectiveId || "(unknown)"}\n`,
    );
    process.exit(1);
  }

  const result = reconstruct(collected, costOf, effectiveId);

  // Apply error detection: override subtype/is_error if we can detect an error
  // from the transcript events or PTY text.  This gives parity with `claude -p`.
  const verdict = detectError(collected, session.snapshot());
  if (verdict?.isError) {
    result.is_error = true;
    result.subtype = verdict.subtype;
    if (verdict.apiErrorStatus !== undefined)
      result.api_error_status = verdict.apiErrorStatus;
  }

  // Extract and validate structured output when --json-schema was used.
  // We drive the TUI with a merged --system-prompt that instructs Claude to
  // output ONLY a JSON object; then we extract and validate it from the
  // assistant's text response. No attachment is needed.
  //
  // On validation failure we stay iso to real `claude -p`: empirically -p sets
  // is_error=true with subtype "success" (NOT "error_max_structured_output_retries")
  // and num_turns=1 — it does NOT retry at the turn level. So we just flag the
  // error in a single turn and omit structured_output; the subtype keeps its
  // reconstructed "success" value. (Verified against claude -p with two
  // impossible schemas: minLength>maxLength and minimum>maximum.)
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
    process.stdout.write(formatText(collected) + "\n");
  } else if (config.outputFormat === "json") {
    process.stdout.write(formatJson(result) + "\n");
  } else {
    if (!emitter) emitter = createStreamJsonEmitter(effectiveId);
    for (const line of emitter.flush()) process.stdout.write(line + "\n");
    process.stdout.write(emitter.onResult(result) + "\n");
  }

  process.exit(result.is_error ? 1 : 0);
}

main();
