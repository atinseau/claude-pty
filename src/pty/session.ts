// src/pty/session.ts
//
// The pty-backed session: spawns the real Claude Code TUI, watches the raw byte
// stream for the ready / turn-done / permission / trust signals (see ./signals),
// injects the user message(s), and exposes a small lifecycle surface. The
// node-pty plumbing lives in ./runtime; the env shaping in ./env; the byte-level
// detectors in ./signals — this module is the state machine that wires them.
//
// Turn-done detection: the prompt reappears AND the stream stays quiet for
// TURN_DONE_DEBOUNCE_MS (800 ms). This debounce prevents false fires between
// tool calls where the TUI briefly re-renders the prompt.

import { spawnSync } from "child_process";
import type { IPty } from "node-pty";
import type { Config } from "../cli/args";
import { CLAUDE_BIN, childEnv } from "./env";
import { lastConinFd, makePtyWriter, ptySpawn } from "./runtime";
import {
  DENY_KEYSTROKE,
  isPermissionPrompt,
  isReady,
  isTrustPrompt,
  TRUST_ACCEPT_KEYSTROKE,
} from "./signals";

export { CLAUDE_BIN };

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

/**
 * Gap between writing the message text and writing the Enter (carriage return)
 * in inject(). The Enter MUST be a separate write a short moment after the text:
 * when the two are sent as one "message\r" write, the interactive TUI — most
 * notably while it is still settling after a --resume history replay — drops the
 * Enter and the turn never submits (the text just sits in the input box). Sending
 * \r on its own, after the typed text has landed, submits reliably.
 */
const INJECT_ENTER_GAP_MS = 80;

const OUTPUT_CAP = 65536;

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
   * Milliseconds since the last byte arrived from the pty. Lets a caller wait for
   * a quiet stream — e.g. drive() holds the --resume injection until the TUI has
   * finished replaying the prior conversation.
   */
  msSinceData: () => number;
  /**
   * Terminate the TUI and its ENTIRE process tree. On Windows the claude TUI
   * spawns its own console subprocesses (MCP servers, hooks); `pty.kill()` alone
   * leaves them running, and under the daemon (a detached, console-less parent)
   * each lingering child pops/flashes a console window. taskkill /T reaps the
   * whole tree so nothing is orphaned. Always use this instead of pty.kill().
   */
  kill: () => void;
  /** False once the pty has exited (claude.exe died). Used to skip dead warm TUIs. */
  alive: () => boolean;
}

/** Per-spawn context. Lets the daemon run the TUI in the CLIENT's cwd/env rather than its own. */
export interface SpawnContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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

  const pty: IPty = ptySpawn(CLAUDE_BIN, args, {
    cols: 120,
    rows: 40,
    cwd: ctx.cwd ?? process.cwd(),
    env: childEnv(ctx.env ?? process.env),
  });
  // Snapshot the conin fd captured during the (synchronous) spawn above, BEFORE
  // any other spawn can overwrite the module global. Bind a writer to it so this
  // session always writes to its own pty even when the process drives several.
  const ptyWrite = makePtyWriter(pty, lastConinFd());

  // Track liveness so a warm pool TUI whose claude.exe has died is never handed
  // out (injecting into a dead pty would just hang until the turn timeout).
  let exited = false;
  pty.onExit(() => {
    exited = true;
  });

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
  // Timestamp of the most recent pty data, so callers can detect a quiet stream
  // (e.g. drive() waits for the --resume history replay to finish before it
  // injects). Initialised to spawn time; updated on every onData.
  let lastDataAt = Date.now();

  // ─── Ready promise (resolves when TUI prompt first appears) ──────────────
  let _readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    _readyResolve = resolve;
  });

  const multiTurnMode = config.message === "";

  pty.onData((data: string) => {
    lastDataAt = Date.now();
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
      // In multi-turn mode: do NOT auto-inject; caller will call inject().
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
   *
   * The Enter is sent as a SEPARATE write a short moment after the text (see
   * INJECT_ENTER_GAP_MS): a combined "message\r" write is dropped by the TUI when
   * it is still settling (e.g. right after a --resume history replay), leaving the
   * text un-submitted. Writing \r on its own once the text has landed submits
   * reliably, for fresh and resumed sessions alike.
   */
  function inject(message: string): void {
    buffer = ""; // clear so a leftover ❯ from the previous turn isn't mistaken for this one
    awaitingTurn = true;
    turnDone = false;
    promptBackSeen = false;
    ptyWrite(message);
    setTimeout(() => ptyWrite("\r"), INJECT_ENTER_GAP_MS);
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
    msSinceData: () => Date.now() - lastDataAt,
    kill,
    alive: () => !exited,
  };
}
