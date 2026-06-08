// spike/calibrate-pty.ts
// Calibration harness — NOT for production. Run once to observe raw TUI output.
// Usage: bun run spike/calibrate-pty.ts
// Writes raw pty output to spike/calibrate-log.txt for inspection.
//
// IMPORTANT: Uses the same scaffolding as hello-pty.ts (createRequire + net.Socket patch).

import { createRequire } from "module";
import { writeFileSync, appendFileSync, existsSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";

const LOG_FILE = "spike/calibrate-log.txt";
if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);

function log(msg: string) {
  process.stdout.write(msg);
  appendFileSync(LOG_FILE, msg);
}

const CLAUDE_BIN = process.env.CLAUDE_PTY_BIN ?? "C:\\Users\\arthur\\.local\\bin\\claude.exe";
const SESSION_ID = randomUUID();
log(`[calibrate] session-id: ${SESSION_ID}\n`);
log(`[calibrate] claude bin: ${CLAUDE_BIN}\n`);
log(`[calibrate] log: ${LOG_FILE}\n\n`);

const _nodePtyPath = process.cwd() + "/node_modules/node-pty/lib/index.js";
const _require = createRequire(_nodePtyPath);

let _coninFd: number | null = null;

if (process.platform === "win32") {
  const net = _require("net");
  const OrigSocket = net.Socket;
  net.Socket = function PatchedSocket(opts?: { fd?: number; readable?: boolean; writable?: boolean }) {
    if (opts && typeof opts.fd === "number" && opts.readable === false && opts.writable === true) {
      _coninFd = opts.fd;
    }
    return new OrigSocket(opts);
  };
  net.Socket.prototype = OrigSocket.prototype;
}

const { spawn } = _require("./index.js") as typeof import("node-pty");
const { writeSync } = _require("fs") as typeof import("fs");

function ptyWrite(data: string): void {
  if (process.platform === "win32" && _coninFd !== null) {
    writeSync(_coninFd, data);
  } else {
    pty.write(data);
  }
}

const pty = spawn(CLAUDE_BIN, [
  "--session-id", SESSION_ID,
  "--permission-mode", "bypassPermissions",
], { cols: 120, rows: 40, cwd: process.cwd() });

let chunkIndex = 0;
let injected = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const startTime = Date.now();

pty.onData((data) => {
  const elapsed = Date.now() - startTime;
  const repr = JSON.stringify(data);
  log(`\n--- chunk #${chunkIndex++} at +${elapsed}ms ---\n`);
  log(`RAW: ${repr}\n`);
  log(`RENDERED:\n${data}\n`);

  if (!injected) {
    // Log all candidate patterns to help derive the ready signal
    // Check for various box-drawing chars and prompt indicators
    const hasBoxVert = /[│║┃|]/.test(data);
    const hasGT = />/.test(data);
    const hasBracket = /\[/.test(data);
    log(`[detect] hasBoxVert=${hasBoxVert} hasGT=${hasGT}\n`);
  }
});

pty.onExit(({ exitCode }) => {
  log(`\n[calibrate] pty exited with code ${exitCode}\n`);
  log(`[calibrate] Full session log saved to ${LOG_FILE}\n`);
  process.exit(0);
});

// Phase 1: Wait for startup, then inject a simple message
log("\n[calibrate] Waiting 8s for TUI to start...\n");
setTimeout(() => {
  if (!injected) {
    log("\n[calibrate] === INJECTING MESSAGE ===\n");
    injected = true;
    ptyWrite("Reply with exactly: pong\r");
  }
}, 8000);

// Phase 2: After 30s total, kill
setTimeout(() => {
  log("\n[calibrate] === TIMEOUT - killing pty ===\n");
  pty.kill();
}, 30000);
