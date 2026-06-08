// src/main.ts
import { parseArgs } from "./cli";
import { startSession } from "./driver";
import { reconstruct } from "./reconstruct";
import { costOf } from "./pricing";
import { formatText } from "./format/text";
import { formatJson } from "./format/json";
import { createStreamJsonEmitter } from "./format/streamjson";
import { makeTranscriptCursor } from "./tailer";
import { resolveSessionId, findTranscriptById, listTranscripts } from "./session";
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

  while (Date.now() < deadline) {
    if (!path) {
      path = await locate();
      if (path) effectiveId = basename(path).replace(/\.jsonl$/, "");
    }
    if (path) {
      const text = await Bun.file(path).text();
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
    process.stderr.write(`transcript not found or empty for session ${effectiveId || "(unknown)"}\n`);
    process.exit(1);
  }

  const result = reconstruct(collected, costOf, effectiveId);

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
