// src/pty/env.ts
//
// Environment shaping for the spawned claude TUI: which binary to drive, and a
// scrubbed copy of the inherited environment. Both are pure(-ish) and free of
// node-pty, so they can be unit-tested without spawning anything.

// Resolve the claude binary to drive: an explicit CLAUDE_PTY_BIN wins; otherwise
// find `claude` on PATH (portable across machines); fall back to the bare name so
// the OS still attempts a PATH lookup at spawn time.
export const CLAUDE_BIN =
  process.env.CLAUDE_PTY_BIN ?? Bun.which("claude") ?? "claude";

/**
 * Build the environment for the spawned claude TUI.
 *
 * Strips the "running inside Claude Code" signal variables (CLAUDECODE and the
 * whole CLAUDE_CODE_* family) from the inherited env. When claude-pty is invoked
 * from within a Claude Code session (or any nested claude context), these leak
 * into the child TUI and make it behave as a sub-session that does NOT persist a
 * normal JSONL transcript — only an `ai-title` line. Since claude-pty's entire
 * design tails that transcript as its source of truth, the child then never
 * produces consumable output and claude-pty hangs until its turn timeout
 * (default 600s) before failing with "transcript not found".
 *
 * claude-pty's own CLAUDE_PTY_* configuration vars use a different prefix and are
 * preserved. Returns a fresh object — never mutates the input.
 *
 * Exported for unit testing — keep this pure (no side-effects).
 */
export function childEnv(
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
}
