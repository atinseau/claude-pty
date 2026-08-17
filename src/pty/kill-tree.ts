// src/pty/kill-tree.ts
//
// Reap a pty's ENTIRE process tree — the claude TUI plus every MCP server and
// hook it spawned. Killing just the TUI's pid is not enough on either platform:
//
//   Windows: pty.kill() leaves the console subprocesses running, and under the
//     daemon (a detached, console-less parent) each lingering child pops or
//     flashes a console window. `taskkill /F /T` reaps the tree.
//
//   unix: pty.kill() sends SIGHUP to the shell pid only. The kernel then SIGHUPs
//     the foreground group as the session leader dies, which happens to clean up
//     ordinary children — but anything that IGNORES SIGHUP survives, and a
//     long-lived MCP server may well do so. Measured on macOS with a child doing
//     `trap '' HUP`: 2 of 4 group members outlived pty.kill(). Signalling the
//     process GROUP (negative pid — the pty put the child in its own session, so
//     pgid == pid) with SIGKILL, which cannot be trapped or ignored, closes it.
//
// SIGKILL/`/F` skips graceful shutdown, which is safe here and matches the
// Windows path: drive() only kills once the turn is complete and its transcript
// has been drained, so nothing is left to flush.

import { spawnSync } from "child_process";

/**
 * Terminate `pid` and its whole tree. Best-effort and idempotent: a pid that is
 * already gone (or a group we may not signal) is not an error — the goal is
 * "nothing left running", and the caller still calls pty.kill() afterwards to let
 * node-pty tear down its own bookkeeping.
 */
export function killTree(pid: number): void {
  if (!pid) return;

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // Fall through — the caller's pty.kill() is the backstop.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the whole process group
  } catch {
    // Not a group leader (or already reaped) — still take the process itself.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}
