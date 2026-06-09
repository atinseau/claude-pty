// src/driver.ts
//
// Thin pty driver: spawns the real Claude Code TUI, detects prompt-ready /
// turn-done signals from the raw byte stream, injects the user message, and
// notifies the caller when the assistant turn completes.
//
// ─── Windows / Bun incompatibilities (see spike/hello-pty.ts for details) ───
//
// 1) Bun net.Socket write bug (Windows):
//    node-pty wraps the ConPTY conin handle in net.Socket({fd, writable:true}).
//    Bun v1.x rejects all writes to fd-based writable sockets ("Socket is
//    closed"). Fix: monkey-patch net.Socket BEFORE node-pty loads to capture
//    the conin fd; write via fs.writeSync(coninFd, data) instead.
//
// 2) bun --compile module resolution:
//    Static import of node-pty would bundle its CJS code and prevent the
//    net.Socket patch from running first. Use createRequire with the absolute
//    CWD-rooted path to node-pty's entry point so the patch fires before
//    node-pty's module init.
//
// ─── Calibrated ready / turn-done detection (Claude Code 2.1.168) ───────────
//
// The raw pty stream is inspected for the prompt character ❯ (U+276F, a heavy
// right-pointing angle quotation mark) followed by a space — this is the exact
// character the TUI renders as its input prompt indicator.
//
// Evidence from calibration run (session cc29e93c-3ac2-4bd3-905b-e86afcd493d1):
//
//   Startup ready (chunk #9):
//     RAW: "...────────────────────────────────────────────────[m❯ [2m..."
//     → The giant initial frame always contains ❯  followed by placeholder text.
//
//   Turn done (chunk #67):
//     RAW: "[?25l...[38;1H❯ [38;2;153;153;153m[40;51H← for agents..."
//     → After the assistant reply, cursor moves to row 38 col 1, prints ❯ .
//
// Both startup and post-turn share the literal substring "❯ " (U+276F +
// U+00A0 NON-BREAKING SPACE) in the raw chunk. IMPORTANT: the space that
// follows ❯ in the actual pty stream is U+00A0 (non-breaking space, 0xa0),
// NOT a regular ASCII space (U+0020). This was confirmed by char-code
// inspection: buffer[1973]=0x276f ("❯"), buffer[1974]=0xa0 (" "). Searching
// for "❯ " (regular space) silently fails.
//
// Turn-done detection: the prompt reappears AND the stream stays quiet for
// TURN_DONE_DEBOUNCE_MS (800 ms). This debounce prevents false fires between
// tool calls where the TUI briefly re-renders the prompt.

import { existsSync } from "fs";
import { createRequire } from "module";
import type { IPty } from "node-pty";
import { dirname } from "path";
import type { Config } from "./cli";

// node-pty must be loaded via createRequire (not a static import) so the
// net.Socket patch below runs first. The createRequire base must point at a
// real on-disk node-pty entry. Three deployment shapes need to work:
//   - `bun run src/main.ts`  → node-pty is at <source>/../node_modules (import.meta.dir).
//   - installed release binary → node-pty is bundled next to the executable,
//     found via dirname(process.execPath)/node_modules (release archives ship
//     claude-pty + node_modules/node-pty in the same directory).
//   - compiled binary run from a project dir → falls back to the real CWD.
// (import.meta.dir is Bun's virtual B:\~BUN path inside a compiled binary, so it
// only matches in dev.) Try each candidate and use the first that exists on disk.
const _nodePtyCandidates = [
  import.meta.dir + "/../node_modules/node-pty/lib/index.js",
  dirname(process.execPath) + "/node_modules/node-pty/lib/index.js",
  process.cwd() + "/node_modules/node-pty/lib/index.js",
];
const _nodePtyPath =
  _nodePtyCandidates.find((p) => existsSync(p)) ?? _nodePtyCandidates[0]!;
const _require = createRequire(_nodePtyPath);

// ─── Patch net.Socket to capture the conin fd (Windows Bun write fix) ────────
let _coninFd: number | null = null;

if (process.platform === "win32") {
  const net = _require("net");
  const OrigSocket = net.Socket;
  net.Socket = function PatchedSocket(opts?: {
    fd?: number;
    readable?: boolean;
    writable?: boolean;
  }) {
    if (
      opts &&
      typeof opts.fd === "number" &&
      opts.readable === false &&
      opts.writable === true
    ) {
      _coninFd = opts.fd;
    }
    return new OrigSocket(opts);
  };
  net.Socket.prototype = OrigSocket.prototype;
}
// ─────────────────────────────────────────────────────────────────────────────

const { spawn: _ptySpawn } = _require(
  "./index.js",
) as typeof import("node-pty");
const { writeSync: _fsWriteSync } = _require("fs") as typeof import("fs");

/** Write to the pty — uses fs.writeSync on Windows due to Bun net.Socket bug. */
function ptyWrite(pty: IPty, data: string): void {
  if (process.platform === "win32" && _coninFd !== null) {
    _fsWriteSync(_coninFd, data);
  } else {
    pty.write(data);
  }
}

const CLAUDE_BIN =
  process.env.CLAUDE_PTY_BIN ?? "C:\\Users\\arthur\\.local\\bin\\claude.exe";

/**
 * Prompt-ready predicate.
 *
 * Matches the raw pty stream when the TUI's input box is ready for input.
 * The signal is "❯" (U+276F, HEAVY RIGHT-POINTING ANGLE QUOTATION MARK)
 * followed by U+00A0 (NON-BREAKING SPACE). Claude Code 2.1.168 consistently
 * emits this two-character sequence when the prompt row is rendered, at both
 * startup and after each assistant turn.
 *
 * CALIBRATION NOTE: The space character after ❯ is U+00A0 (0xa0), NOT a
 * regular ASCII space (U+0020). This was confirmed by char-code inspection of
 * the live pty buffer (session cc29e93c-3ac2-4bd3-905b-e86afcd493d1):
 *   buffer[1973] = 0x276f  (❯)
 *   buffer[1974] = 0x00a0  (NBSP — the "space" after the prompt char)
 * Searching for "❯ " (ASCII space) silently fails.
 *
 * Exported for unit testing — keep this pure (no side-effects).
 */
export function isReady(buffer: string): boolean {
  // U+276F followed by U+00A0 (non-breaking space) — the real prompt signal.
  return buffer.includes("❯ ");
}

/**
 * Detects the interactive permission-confirmation box.
 *
 * The dialog renders two reliable literal ASCII substrings (no NBSP):
 *   "This command requires approval"  — row 26 of the permission box
 *   "Do you want to proceed?"         — row 28 of the permission box
 *
 * Verified in docs/superpowers/findings/spike-B-permission.md (Claude Code
 * 2.1.168, session 0a722727). Both strings appear in the same pty chunk
 * (#154) so matching either one is sufficient.
 *
 * Exported for unit testing — keep this pure (no side-effects).
 */
export function isPermissionPrompt(buffer: string): boolean {
  return (
    buffer.includes("This command requires approval") ||
    buffer.includes("Do you want to proceed?")
  );
}

/**
 * Keystroke that dismisses the permission box (ESC, single byte 0x1B).
 *
 * Verified in spike-B-permission.md: after sending ESC the dialog clears
 * within ~100ms, the tool is NOT executed, and the assistant turn continues
 * normally until the prompt-ready signal reappears.
 */
export const DENY_KEYSTROKE = "";

/** Rolling buffer cap in bytes — keeps memory bounded. */
const BUFFER_CAP = 16384;

/** Debounce window after prompt reappears before firing onTurnDone. */
const TURN_DONE_DEBOUNCE_MS = 800;

export interface DriverHooks {
  onReady?: () => void;
  onTurnDone?: () => void;
}

export interface Session {
  pty: IPty;
  snapshot: () => string;
  /**
   * Resolves when the first prompt-ready signal is seen (TUI has started up).
   * Useful in multi-turn mode: await ready before calling send().
   */
  ready: Promise<void>;
  /**
   * Inject a message and await completion of that turn (prompt returns + debounce).
   * Only valid in multi-turn mode (config.message === "").
   * Rejects if called while a turn is already in progress.
   */
  send: (message: string) => Promise<void>;
}

/**
 * Spawn the Claude Code TUI in a pty, inject config.message, and call hooks
 * when the prompt is ready and when the assistant turn completes.
 *
 * Returns a Session with the IPty and a snapshot() function for pty output.
 *
 * Single-turn mode (config.message non-empty):
 *   Injects the message once after the first prompt-ready signal, calls
 *   hooks.onTurnDone when the turn completes. Behavior is unchanged.
 *
 * Multi-turn mode (config.message === ""):
 *   Does NOT auto-inject. Caller awaits session.ready, then calls session.send()
 *   sequentially for each message.
 */
export function startSession(config: Config, hooks: DriverHooks = {}): Session {
  // Build args: skip --session-id injection when passthrough already has a
  // session flag, or when --resume/--continue is in use, or sessionId is empty.
  const hasSessionFlag =
    config.passthrough.includes("--session-id") ||
    config.passthrough.includes("--resume") ||
    config.passthrough.includes("-r") ||
    config.passthrough.includes("--continue") ||
    config.passthrough.includes("-c");

  const args: string[] =
    config.sessionId && !hasSessionFlag
      ? ["--session-id", config.sessionId, ...config.passthrough]
      : [...config.passthrough];

  const pty: IPty = _ptySpawn(CLAUDE_BIN, args, {
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
  });

  let buffer = "";
  let injected = false;
  // Turn-done detection only starts once the message has actually been written
  // (after the 50ms render delay), so the startup ready-signal can't be mistaken
  // for the post-turn one in the window before injection completes.
  let awaitingTurn = false;
  let turnDone = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Tracks the last permission box we denied — guards against re-firing on re-renders.
  let lastDeniedBox = "";

  let outputLog = "";
  const OUTPUT_CAP = 65536;

  // ─── Ready promise (resolves when TUI prompt first appears) ──────────────
  let _readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    _readyResolve = resolve;
  });

  // ─── Per-turn send() resolver (multi-turn mode) ───────────────────────────
  let _sendResolve: (() => void) | null = null;

  const multiTurnMode = config.message === "";

  pty.onData((data: string) => {
    buffer += data;
    if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP);
    outputLog += data;
    if (outputLog.length > OUTPUT_CAP) outputLog = outputLog.slice(-OUTPUT_CAP);

    if (!injected && isReady(buffer)) {
      injected = true;
      hooks.onReady?.();
      _readyResolve?.();
      _readyResolve = null;

      if (!multiTurnMode) {
        // Single-turn: auto-inject the message after 50ms render delay.
        setTimeout(() => {
          ptyWrite(pty, config.message + "\r");
          buffer = ""; // reset so the post-turn ready check starts clean
          awaitingTurn = true;
        }, 50);
      }
      // In multi-turn mode: do NOT auto-inject; caller will call send().
      return;
    }

    // Auto-deny permission box (faithful to claude -p which denies tools outside --allowedTools).
    // Fires once per unique box render: send ESC, which clears the dialog without executing the tool.
    // The turn continues normally after dismissal and eventually fires onTurnDone via the prompt signal.
    if (injected && isPermissionPrompt(buffer)) {
      const marker = buffer.slice(-300);
      if (marker !== lastDeniedBox) {
        lastDeniedBox = marker;
        ptyWrite(pty, DENY_KEYSTROKE);
      }
    }

    if (awaitingTurn && !turnDone) {
      // After injection, wait for the prompt to reappear AND the stream to
      // go quiet (debounce) before declaring the turn done — exactly once.
      if (isReady(buffer)) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (turnDone) return;
          turnDone = true;
          hooks.onTurnDone?.();
          // Resolve the pending send() promise (multi-turn mode).
          const resolve = _sendResolve;
          _sendResolve = null;
          resolve?.();
        }, TURN_DONE_DEBOUNCE_MS);
      }
    }
  });

  /**
   * Multi-turn send: injects a message and returns a Promise that resolves
   * when that turn's prompt-done signal is observed (prompt reappears + debounce).
   */
  function send(message: string): Promise<void> {
    if (awaitingTurn && !turnDone) {
      return Promise.reject(
        new Error("send() called while a turn is already in progress"),
      );
    }
    return new Promise<void>((resolve) => {
      _sendResolve = resolve;
      buffer = ""; // Clear buffer so leftover ❯ from previous turn doesn't instantly satisfy
      awaitingTurn = true;
      turnDone = false;
      ptyWrite(pty, message + "\r");
    });
  }

  return { pty, snapshot: () => outputLog, ready: readyPromise, send };
}
