// src/main.ts

import { parseArgs } from "./cli/args";
import { helpText } from "./cli/help";
import { readStdin } from "./cli/stdin";
import { runViaDaemon } from "./daemon/client";
import { runDaemon } from "./daemon/server";
import { handleNodePtyAgentInvocation } from "./pty/agent-guard";
import { startSession } from "./pty/session";
import { drive } from "./run/drive";
import {
  MISSING_INPUT_ERROR,
  missingInput,
  prepare,
  turnTimeoutMs,
} from "./run/prepare";

// FIRST: if node-pty forked us as its conpty console-list agent (only possible in
// a compiled binary, where process.execPath is us), answer its IPC and exit.
// Falling through to main() here is exactly what would fork-bomb under the
// daemon. See src/node-pty-agent.ts.
handleNodePtyAgentInvocation(process.argv);

/** Direct path: spawn the TUI in-process and drive it (the default, always-works route). */
async function runDirect(argv: string[], stdinText: string): Promise<number> {
  let config: ReturnType<typeof parseArgs>;
  try {
    config = parseArgs(argv);
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    return 2;
  }
  if (config.help) {
    process.stdout.write(helpText());
    return 0;
  }

  const cwd = process.cwd();
  const { sess, ndjsonMessages, preExisting } = await prepare(
    config,
    argv,
    stdinText,
    cwd,
  );

  // Nothing to submit: fail fast like `claude -p` instead of spawning a TUI
  // that would idle until the turn timeout.
  if (missingInput(config, sess)) {
    process.stderr.write(MISSING_INPUT_ERROR + "\n");
    return 1;
  }

  let ptyDone = false;
  const session = startSession(config, {
    onTurnDone: () => {
      ptyDone = true;
    },
  });

  // drive() owns the session lifecycle (it kills the single-use pty before
  // formatting output, as the previous inline flow did).
  return drive(
    config,
    session,
    {
      sess,
      preExisting,
      ndjsonMessages,
      ptyDone: () => ptyDone,
      cwd,
      turnTimeoutMs: turnTimeoutMs(process.env),
    },
    {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    },
  );
}

async function main() {
  const argv = Bun.argv.slice(2);

  // `--daemon`: become the daemon server (never returns). Handled before any
  // arg parsing so it can't be confused with claude flags.
  if (argv.includes("--daemon")) {
    runDaemon();
    return;
  }

  const stdinText = await readStdin();

  // Daemon is OPT-IN (CLAUDE_PTY_DAEMON=1) and always overridable with
  // --no-daemon. On any daemon failure runViaDaemon returns null and we fall
  // through to the direct path — identical behaviour, never a hard failure.
  const useDaemon =
    process.env.CLAUDE_PTY_DAEMON === "1" && !argv.includes("--no-daemon");
  if (useDaemon) {
    const code = await runViaDaemon(argv, stdinText);
    if (code !== null) process.exit(code);
  }

  process.exit(await runDirect(argv, stdinText));
}

main();
