// src/main.ts

import { helpText, parseArgs } from "./cli";
import { drive } from "./drive";
import { startSession } from "./driver";
import { parseNdjsonMessages } from "./ndjson";
import { listTranscripts, resolveSessionId } from "./session";
import { combineMessage, readStdin } from "./stdin";

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

  let ptyDone = false;
  const session = startSession(config, {
    onTurnDone: () => {
      ptyDone = true;
    },
  });

  // drive() owns the session lifecycle (it kills the single-use pty before
  // formatting output, as the previous inline flow did).
  const code = await drive(
    config,
    session,
    { sess, preExisting, ndjsonMessages, ptyDone: () => ptyDone },
    {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    },
  );

  process.exit(code);
}

main();
