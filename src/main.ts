// src/main.ts
import { parseArgs } from "./cli";
import { startSession } from "./driver";
import { parseTranscript } from "./transcript";
import { reconstruct } from "./reconstruct";
import { costOf } from "./pricing";
import { formatText } from "./format/text";
import { formatJson } from "./format/json";
import { formatStreamJson } from "./format/streamjson";
import type { TranscriptEvent } from "./types";
import { homedir } from "os";
import { join } from "path";

async function findTranscript(sessionId: string): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects");
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
  for await (const f of glob.scan({ cwd: root, absolute: true })) return f;
  return null;
}

/**
 * Poll the transcript until the final assistant event has stop_reason !== "tool_use"
 * (indicating the turn really ended), or until the timeout elapses.
 *
 * The pty going idle (onTurnDone) does NOT guarantee the transcript file has been
 * fully flushed — Claude Code writes the JSONL asynchronously. We re-read every
 * 150 ms until we see a stable terminal assistant event, or bail after ~5 s.
 */
async function readStableTranscript(
  sessionId: string,
  timeoutMs = 5000,
  pollMs = 150,
): Promise<TranscriptEvent[]> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const path = await findTranscript(sessionId);
    if (path) {
      const text = await Bun.file(path).text();
      const events = parseTranscript(text);

      // Filter to assistant events
      const assistants = events.filter(
        (e): e is Extract<TranscriptEvent, { kind: "assistant" }> =>
          e.kind === "assistant",
      );

      const last = assistants[assistants.length - 1];

      // A turn is stable when the last assistant event is NOT a tool_use stop
      // (tool_use means Claude is pausing between tool calls, not done).
      if (last && last.stop_reason !== "tool_use") {
        return events;
      }
    }

    // Wait before next poll
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }

  // Last attempt — return whatever we have even if still incomplete
  const path = await findTranscript(sessionId);
  if (path) {
    const text = await Bun.file(path).text();
    return parseTranscript(text);
  }
  return [];
}

async function main() {
  const config = parseArgs(Bun.argv.slice(2));

  // Wait for the pty driver to signal that the assistant turn is done, with a
  // global deadline so a broken readiness signal (e.g. a future Claude Code
  // version changing the prompt) fails loudly instead of hanging forever.
  const turnTimeoutMs = Number(process.env.CLAUDE_PTY_TURN_TIMEOUT_MS) || 600_000;
  const timedOut = await new Promise<boolean>((resolve) => {
    const pty = startSession(config, {
      onTurnDone: () => {
        clearTimeout(timer);
        pty.kill();
        resolve(false);
      },
    });
    const timer = setTimeout(() => {
      pty.kill();
      resolve(true);
    }, turnTimeoutMs);
  });

  if (timedOut) {
    process.stderr.write(
      `timed out after ${turnTimeoutMs}ms waiting for the turn to complete ` +
        `(session ${config.sessionId})\n`,
    );
    process.exit(1);
  }

  // Now poll the transcript for a stable final assistant event (flush timing fix).
  const events = await readStableTranscript(config.sessionId);

  if (events.length === 0) {
    process.stderr.write(
      `transcript not found or empty for session ${config.sessionId}\n`,
    );
    process.exit(1);
  }

  const result = reconstruct(events, costOf, config.sessionId);

  if (config.outputFormat === "text") {
    process.stdout.write(formatText(events) + "\n");
  } else if (config.outputFormat === "json") {
    process.stdout.write(formatJson(result) + "\n");
  } else {
    const firstAssistant = events.find(
      (e): e is Extract<TranscriptEvent, { kind: "assistant" }> =>
        e.kind === "assistant",
    );
    const model = firstAssistant ? firstAssistant.model : "";
    for (const line of formatStreamJson(events, result, { model })) {
      process.stdout.write(line + "\n");
    }
  }

  process.exit(result.is_error ? 1 : 0);
}

main();
