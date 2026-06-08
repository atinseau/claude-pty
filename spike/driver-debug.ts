// spike/driver-debug.ts
// Debug version with logging to understand why isReady doesn't fire.

import { createRequire } from "module";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, unlinkSync } from "fs";

const LOG_FILE = "spike/driver-debug-log.txt";
if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);

function log(msg: string) {
  process.stdout.write(msg);
  appendFileSync(LOG_FILE, msg);
}

const CLAUDE_BIN = process.env.CLAUDE_PTY_BIN ?? "C:\\Users\\arthur\\.local\\bin\\claude.exe";
const SESSION_ID = randomUUID();
log(`[debug] session-id: ${SESSION_ID}\n`);

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

let buffer = "";
let injected = false;
let chunkIdx = 0;
const t0 = Date.now();

pty.onData((data: string) => {
  buffer += data;
  if (buffer.length > 16384) buffer = buffer.slice(-16384);

  const elapsed = Date.now() - t0;
  const hasReadySig = buffer.includes("❯ ");
  const dataHasIt = data.includes("❯ ");

  log(`[${elapsed}ms] chunk#${chunkIdx++} len=${data.length} buffer=${buffer.length} dataHasPrompt=${dataHasIt} bufHasPrompt=${hasReadySig} injected=${injected}\n`);

  if (!injected && hasReadySig) {
    log(`  → READY detected! Injecting message...\n`);
    injected = true;
    setTimeout(() => {
      ptyWrite("Reply with exactly: pong\r");
      buffer = "";
    }, 50);
  }
});

pty.onExit(({ exitCode }) => {
  log(`\n[debug] pty exited: ${exitCode}\n`);
});

setTimeout(() => {
  log(`\n[debug] TIMEOUT - injected=${injected}\n`);
  log(`[debug] Last buffer snippet (last 500 chars): ${JSON.stringify(buffer.slice(-500))}\n`);
  pty.kill();
  process.exit(0);
}, 20000);
