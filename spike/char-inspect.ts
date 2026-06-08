// spike/char-inspect.ts
// Inspect what character code the pty stream actually sends for the prompt char.

import { createRequire } from "module";
import { randomUUID } from "crypto";

const CLAUDE_BIN = "C:\\Users\\arthur\\.local\\bin\\claude.exe";
const SESSION_ID = randomUUID();

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

const pty = spawn(CLAUDE_BIN, [
  "--session-id", SESSION_ID,
  "--permission-mode", "bypassPermissions",
], { cols: 120, rows: 40, cwd: process.cwd() });

let accumulated = "";
let done = false;

pty.onData((data: string) => {
  accumulated += data;

  if (accumulated.length > 3000 && !done) {
    done = true;

    // Find the area around what looks like the prompt
    // The rendered calibration log showed the pattern near "Try "
    const tryIdx = accumulated.indexOf("Try ");
    if (tryIdx > 0) {
      const snippet = accumulated.slice(Math.max(0, tryIdx - 20), tryIdx + 50);
      console.log(`Snippet near 'Try': ${JSON.stringify(snippet)}`);

      // Print char codes around it
      for (let i = Math.max(0, tryIdx - 20); i < Math.min(accumulated.length, tryIdx + 10); i++) {
        const ch = accumulated[i];
        const code = accumulated.charCodeAt(i);
        if (code > 31 || ch === "\n" || ch === "\r") {
          console.log(`  [${i - tryIdx + 20}] char=${JSON.stringify(ch)} code=0x${code.toString(16)} (${code})`);
        }
      }
    }

    // Also search for common "heavy right" chars
    const prompts = ["❯", ">", "►", "→", "▶"];
    for (const p of prompts) {
      const idx = accumulated.indexOf(p);
      console.log(`\nSearch for ${JSON.stringify(p)} (U+${p.charCodeAt(0).toString(16).padStart(4,"0")}): idx=${idx}`);
    }

    // Also look for ESC[m followed by any char
    const escm = accumulated.indexOf("\x1b[m");
    if (escm >= 0) {
      const after = accumulated.slice(escm, escm + 20);
      console.log(`\nFirst \\x1b[m at ${escm}, followed by: ${JSON.stringify(after)}`);
      // Enumerate codes
      for (let i = escm + 3; i < escm + 10 && i < accumulated.length; i++) {
        const code = accumulated.charCodeAt(i);
        console.log(`  byte[${i-escm-3}]: 0x${code.toString(16)} (${code})`);
      }
    }

    pty.kill();
    process.exit(0);
  }
});

setTimeout(() => { pty.kill(); process.exit(1); }, 15000);
