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

import { spawnSync } from "child_process";
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
// node-pty creates the conin (write-to-shell) socket SYNCHRONOUSLY inside its
// spawn(). This module global holds the fd captured by the most recent such
// creation; startSession snapshots it immediately after _ptySpawn() returns so
// EACH session gets ITS OWN conin fd. (A single module global would break the
// moment one process drives more than one TUI — e.g. the daemon — because writes
// for session #2 would target session #1's now-closed fd.)
let _lastConinFd: number | null = null;

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
      _lastConinFd = opts.fd;
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

/**
 * Build a per-session writer bound to THIS pty's captured conin fd. On Windows
 * uses fs.writeSync(coninFd) due to the Bun net.Socket write bug; elsewhere
 * delegates to pty.write.
 */
function makePtyWriter(pty: IPty, coninFd: number | null) {
  return (data: string): void => {
    if (process.platform === "win32" && coninFd !== null) {
      _fsWriteSync(coninFd, data);
    } else {
      pty.write(data);
    }
  };
}

const CLAUDE_BIN =
  process.env.CLAUDE_PTY_BIN ?? "C:\\Users\\arthur\\.local\\bin\\claude.exe";

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

/**
 * Detects the workspace-trust dialog ("Is this a project you ... trust?").
 *
 * On the VERY FIRST run in a directory Claude has never seen (no
 * `hasTrustDialogAccepted: true` for that path in ~/.claude.json), the
 * interactive TUI renders a full-screen trust prompt BEFORE the input prompt is
 * ever ready. If left unanswered, the prompt-ready signal (❯ + NBSP) never
 * appears and claude-pty hangs forever. `claude -p` skips this dialog; the
 * interactive TUI does not.
 *
 * Verified in docs/superpowers/findings/spike-D-trust.md (Claude Code 2.1.169,
 * fresh dir C:\Temp\cp-trust-*). The dialog's raw pty frame looks like:
 *
 *   "...[3;2HAccessing[1Cworkspace:...
 *      Is[1Cthis[1Ca[1Cproject[1Cyou[1Ccreated...trust?...
 *      [14;2H❯...1.[1CYes,[1CI[1Ctrust[1Cthis[1Cfolder
 *      [15;4H2.[m[1CNo,[1Cexit
 *      [17;2HEnter[1Cto[1Cconfirm..."
 *
 * IMPORTANT: words inside the dialog are separated by `[1C` (cursor-forward
 * one column) escapes, NOT literal spaces — so multi-word phrases like
 * "Yes, I trust this folder" do NOT appear as contiguous substrings. The matcher
 * therefore keys off SINGLE contiguous tokens that survive intact in the stream:
 * the two option labels "Yes," and "No," plus the word "trust". Requiring all
 * three together avoids false-positives on ordinary output.
 *
 * Exported for unit testing — keep this pure (no side-effects).
 */
export function isTrustPrompt(buffer: string): boolean {
  return (
    buffer.includes("Yes,") &&
    buffer.includes("No,") &&
    buffer.includes("trust")
  );
}

/**
 * Keystroke that ACCEPTS the trust dialog (Enter / carriage return, 0x0D).
 *
 * The dialog's default selection is option 1 ("❯ 1. Yes, I trust this folder")
 * and the footer reads "Enter to confirm". Verified in spike-D-trust.md: sending
 * "\r" selects "Yes, I trust this folder" (the TUI redraws it with a ✔), the
 * directory is recorded as trusted, and the session then renders the normal
 * welcome frame containing the prompt-ready signal (❯ + NBSP) — the hang is gone.
 */
export const TRUST_ACCEPT_KEYSTROKE = "\r";

/** Rolling buffer cap in bytes — keeps memory bounded. */
const BUFFER_CAP = 16384;

/** Debounce window after prompt reappears before firing onTurnDone. */
const TURN_DONE_DEBOUNCE_MS = 800;

/**
 * Settling delay between the first prompt-ready signal and injecting the
 * message. Lets the TUI finish painting its input box so the keystrokes land in
 * a stable prompt. Verified reliable at this value against Claude Code 2.1.169.
 */
const INJECT_RENDER_DELAY_MS = 25;

export interface DriverHooks {
  onReady?: () => void;
  onTurnDone?: () => void;
}

export interface Session {
  pty: IPty;
  snapshot: () => string;
  /**
   * Resolves when the first prompt-ready signal is seen (TUI has started up).
   * Useful in multi-turn mode: await ready before calling inject().
   */
  ready: Promise<void>;
  /**
   * Multi-turn: inject a message (fire-and-forget). The caller drives turn
   * completion from the transcript (countTerminalTurns) rather than waiting out
   * the pty debounce, and gates the NEXT inject() on promptBack() so keystrokes
   * never land before the input prompt has returned.
   */
  inject: (message: string) => void;
  /**
   * True once the input prompt has reappeared since the last inject() — i.e. the
   * TUI is ready to receive the next message. Reset by inject().
   */
  promptBack: () => boolean;
  /**
   * Terminate the TUI and its ENTIRE process tree. On Windows the claude TUI
   * spawns its own console subprocesses (MCP servers, hooks); `pty.kill()` alone
   * leaves them running, and under the daemon (a detached, console-less parent)
   * each lingering child pops/flashes a console window. taskkill /T reaps the
   * whole tree so nothing is orphaned. Always use this instead of pty.kill().
   */
  kill: () => void;
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
 *   Does NOT auto-inject. Caller awaits session.ready, then calls session.inject()
 *   for each message, sequencing turns off the transcript + promptBack().
 */
/** Per-spawn context. Lets the daemon run the TUI in the CLIENT's cwd/env rather than its own. */
export interface SpawnContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function startSession(
  config: Config,
  hooks: DriverHooks = {},
  ctx: SpawnContext = {},
): Session {
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
    cwd: ctx.cwd ?? process.cwd(),
    env: childEnv(ctx.env ?? process.env),
  });
  // Snapshot the conin fd captured during the (synchronous) spawn above, BEFORE
  // any other spawn can overwrite the module global. Bind a writer to it so this
  // session always writes to its own pty even when the process drives several.
  const ptyWrite = makePtyWriter(pty, _lastConinFd);

  let buffer = "";
  // Trust dialog is accepted at most once, in the PRE-ready phase (before the
  // input prompt ever appears). See isTrustPrompt() for why this must not be
  // gated behind `injected`.
  let trustAccepted = false;
  let injected = false;
  // Turn-done detection only starts once the message has actually been written
  // (after the 50ms render delay), so the startup ready-signal can't be mistaken
  // for the post-turn one in the window before injection completes.
  let awaitingTurn = false;
  let turnDone = false;
  // Multi-turn injection gate: set when the input prompt reappears after an
  // inject(), cleared by the next inject(). Lets the caller hold the next
  // message until the TUI is ready to receive it — without the 800ms debounce.
  let promptBackSeen = false;
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

  const multiTurnMode = config.message === "";

  pty.onData((data: string) => {
    buffer += data;
    if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP);
    outputLog += data;
    if (outputLog.length > OUTPUT_CAP) outputLog = outputLog.slice(-OUTPUT_CAP);

    // ─── Pre-ready: auto-accept the workspace-trust dialog (first-run only) ──
    // This dialog appears BEFORE the input prompt is ready, so it must be
    // handled here, NOT gated behind `injected`/`awaitingTurn` (otherwise the
    // session hangs waiting for a ready signal that never comes). Fire exactly
    // once: send Enter to confirm "Yes, I trust this folder", then reset the
    // buffer so the trust tokens can't re-trigger and the subsequent welcome
    // frame's ready signal is detected cleanly.
    if (!trustAccepted && !injected && isTrustPrompt(buffer)) {
      trustAccepted = true;
      ptyWrite(TRUST_ACCEPT_KEYSTROKE);
      buffer = "";
      return;
    }

    if (!injected && isReady(buffer)) {
      injected = true;
      hooks.onReady?.();
      _readyResolve?.();
      _readyResolve = null;

      if (!multiTurnMode) {
        // Single-turn: auto-inject the message after a short render-settle delay.
        setTimeout(() => {
          ptyWrite(config.message + "\r");
          buffer = ""; // reset so the post-turn ready check starts clean
          awaitingTurn = true;
        }, INJECT_RENDER_DELAY_MS);
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
        ptyWrite(DENY_KEYSTROKE);
      }
    }

    if (awaitingTurn && !turnDone) {
      if (isReady(buffer)) {
        // Prompt is back: the TUI can accept the next message. In multi-turn
        // this latch (not a timer) gates the next inject(); in single-turn we
        // still debounce before declaring the turn done via onTurnDone.
        promptBackSeen = true;
        if (!multiTurnMode) {
          // After injection, wait for the prompt to reappear AND the stream to
          // go quiet (debounce) before declaring the turn done — exactly once.
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (turnDone) return;
            turnDone = true;
            hooks.onTurnDone?.();
          }, TURN_DONE_DEBOUNCE_MS);
        }
      }
    }
  });

  /**
   * Multi-turn inject: write a message to the TUI (fire-and-forget). Resets the
   * promptBack latch so the caller can detect when THIS turn's prompt returns.
   * Turn completion is observed by the caller from the transcript.
   */
  function inject(message: string): void {
    buffer = ""; // clear so a leftover ❯ from the previous turn isn't mistaken for this one
    awaitingTurn = true;
    turnDone = false;
    promptBackSeen = false;
    ptyWrite(message + "\r");
  }

  function kill(): void {
    // Reap the WHOLE claude.exe tree (the TUI plus any MCP/hook subprocesses it
    // spawned). On Windows pty.kill() alone leaves those children running; under
    // the daemon they linger and flash console windows. taskkill /T handles the
    // tree; run it hidden so the kill itself doesn't pop a window.
    const pid = pty.pid;
    if (process.platform === "win32" && pid) {
      try {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        /* fall through to pty.kill */
      }
    }
    try {
      pty.kill();
    } catch {
      /* already dead */
    }
  }

  return {
    pty,
    snapshot: () => outputLog,
    ready: readyPromise,
    inject,
    promptBack: () => promptBackSeen,
    kill,
  };
}
