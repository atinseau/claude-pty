// spike/char-inspect2.ts
// After 3 seconds, dump the entire buffer to inspect characters.

import { createRequire } from "module";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";

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

const pty = spawn(CLAUDE_BIN, [
  "--session-id", SESSION_ID,
  "--permission-mode", "bypassPermissions",
], { cols: 120, rows: 40, cwd: process.cwd() });

let buffer = "";

pty.onData((data: string) => {
  buffer += data;
});

// After 3 seconds, dump what we have
setTimeout(() => {
  writeFileSync("spike/char-dump.json", JSON.stringify(buffer));
  console.log(`Buffer length: ${buffer.length}`);

  // Search for various chars
  const chars = [
    { name: "❯ (U+276F)", char: "❯" },
    { name: "❯ string", char: "❯" },
    { name: "> ", char: "> " },
    { name: "\\u001b[m❯", char: "\x1b[m❯" },
    { name: "\\u001b[m>", char: "\x1b[m>" },
  ];

  for (const { name, char } of chars) {
    const idx = buffer.indexOf(char);
    if (idx >= 0) {
      const ctx = buffer.slice(Math.max(0, idx - 5), idx + char.length + 10);
      console.log(`Found ${name} at idx ${idx}: ${JSON.stringify(ctx)}`);
    } else {
      console.log(`NOT found: ${name}`);
    }
  }

  // Print char codes for the first 200 chars to find the prompt
  console.log("\nChar codes dump (first 2500 chars where code > 127):");
  for (let i = 0; i < Math.min(buffer.length, 2500); i++) {
    const code = buffer.charCodeAt(i);
    if (code > 127) {
      console.log(`  idx=${i} code=0x${code.toString(16)} char=${JSON.stringify(buffer[i])}`);
    }
  }

  pty.kill();
  process.exit(0);
}, 3000);
