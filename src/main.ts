// src/main.ts
import { parseArgs } from "./cli";
import { combineMessage, readStdin } from "./stdin";
import { startSession } from "./driver";
import { reconstruct } from "./reconstruct";
import { costOf } from "./pricing";
import { formatText } from "./format/text";
import { formatJson } from "./format/json";
import { createStreamJsonEmitter } from "./format/streamjson";
import { makeTranscriptCursor } from "./tailer";
import { resolveSessionId, findTranscriptById, listTranscripts } from "./session";
import { detectError } from "./errors";
import { extractStructuredOutput } from "./structured";
import { basename } from "path";
import type { TranscriptEvent } from "./types";

const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_PTY_TURN_TIMEOUT_MS) || 600_000;
const POLL_MS = 120;

function isTerminal(events: TranscriptEvent[]): boolean {
  const a = events.filter((e): e is Extract<TranscriptEvent, { kind: "assistant" }> => e.kind === "assistant");
  const last = a[a.length - 1];
  return !!last && last.stop_reason !== "tool_use" && last.stop_reason !== null;
}

async function main() {
  const argv = Bun.argv.slice(2);
  const config = parseArgs(argv);
  const stdinText = await readStdin();
  config.message = combineMessage(config.message, stdinText);
  const sess = resolveSessionId(argv);
  // Single source of truth for the id the driver injects (fixes double-generation).
  config.sessionId = sess.sessionId ?? "";

  // --continue always forks a NEW transcript file (Spike C): snapshot before spawn
  // so we can detect the newly-appeared file to tail.
  const preExisting = sess.mode === "continue" ? new Set(await listTranscripts(process.cwd())) : null;

  const cursor = makeTranscriptCursor();
  const collected: TranscriptEvent[] = [];
  let emitter: ReturnType<typeof createStreamJsonEmitter> | null = null;
  let effectiveId = sess.sessionId ?? "";

  let ptyDone = false;
  const session = startSession(config, { onTurnDone: () => { ptyDone = true; } });

  async function locate(): Promise<string | null> {
    if (sess.sessionId) return findTranscriptById(sess.sessionId);
    const current = await listTranscripts(process.cwd()); // continue mode
    return current.find((f) => !preExisting!.has(f)) ?? null;
  }

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let path: string | null = null;
  let sawTerminal = false;
  let lastText = "";

  while (Date.now() < deadline) {
    if (!path) {
      path = await locate();
      if (path) effectiveId = basename(path).replace(/\.jsonl$/, "");
    }
    if (path) {
      const text = await Bun.file(path).text();
      lastText = text;
      const fresh = cursor.consume(text);
      for (const e of fresh) {
        collected.push(e);
        if (config.outputFormat === "stream-json") {
          if (!emitter) emitter = createStreamJsonEmitter(effectiveId);
          for (const line of emitter.onEvent(e)) process.stdout.write(line + "\n");
        }
      }
      sawTerminal = isTerminal(collected);
    }
    if (ptyDone && sawTerminal) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
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
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        duration_ms: 0,
        num_turns: 0,
        is_error: true,
        ...(earlyVerdict.apiErrorStatus !== undefined ? { api_error_status: earlyVerdict.apiErrorStatus } : {}),
      };
      if (config.outputFormat === "text") {
        // text mode: just signal the error on stderr
        process.stderr.write(`error: ${earlyVerdict.subtype}${earlyVerdict.apiErrorStatus ? ` (${earlyVerdict.apiErrorStatus})` : ""}\n`);
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
    process.stderr.write(`transcript not found or empty for session ${effectiveId || "(unknown)"}\n`);
    process.exit(1);
  }

  const result = reconstruct(collected, costOf, effectiveId);

  // Apply error detection: override subtype/is_error if we can detect an error
  // from the transcript events or PTY text.  This gives parity with `claude -p`.
  const verdict = detectError(collected, session.snapshot());
  if (verdict?.isError) {
    result.is_error = true;
    result.subtype = verdict.subtype;
    if (verdict.apiErrorStatus !== undefined) result.api_error_status = verdict.apiErrorStatus;
  }

  // Extract structured output from the raw transcript when --json-schema was used.
  // The attachment line is NOT surfaced by parseLine/parseTranscript, so we read
  // directly from the raw transcript text rather than the parsed event stream.
  const structured = extractStructuredOutput(lastText);
  if (structured !== undefined) result.structured_output = structured;

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
