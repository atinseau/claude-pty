// src/node-pty-agent.ts
//
// Guard against node-pty's conpty console-list agent fork.
//
// On Windows, node-pty enumerates a pty's child console processes by calling
// `child_process.fork(<lib>/conpty_console_list_agent, [shellPid])`. fork() runs
// `process.execPath <agent> <pid>`. Under `bun run`, execPath is bun, which runs
// the agent script correctly. But in a `bun build --compile` binary, execPath is
// THIS binary — so the fork re-enters claude-pty's own entry point instead of the
// agent. Without a guard it would run main(): spawn a spurious TUI and, with the
// daemon enabled (CLAUDE_PTY_DAEMON=1 inherited by the fork), recurse into a
// fork bomb (each TUI's kill forks another agent → another client → another TUI).
//
// The agent's only job is to report the child console list back over fork()'s IPC
// channel. We reply with an empty list and exit: node-pty then kills just the
// shell, and claude-pty's own session.kill() taskkill /T reaps the full tree, so
// nothing is lost. Detection is a pure check on argv (exported for testing).

/** True if this process was launched by node-pty as its conpty console-list agent. */
export function isNodePtyAgentInvocation(argv: string[]): boolean {
  return argv.some((a) => a.includes("conpty_console_list_agent"));
}

/**
 * If this process is a node-pty agent fork, satisfy node-pty's IPC and exit —
 * BEFORE any main()/daemon logic runs. No-op (returns) for normal invocations.
 */
export function handleNodePtyAgentInvocation(argv: string[]): void {
  if (!isNodePtyAgentInvocation(argv)) return;
  try {
    (process as { send?: (m: unknown) => void }).send?.({
      consoleProcessList: [],
    });
  } catch {
    /* no IPC channel — nothing to answer */
  }
  process.exit(0);
}
