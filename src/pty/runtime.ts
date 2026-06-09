// src/pty/runtime.ts
//
// node-pty loading + the Windows/Bun plumbing required to make it work. This is
// the ONLY module that touches node-pty's CJS internals, and the only one whose
// load ORDER matters: the net.Socket patch below MUST run before node-pty's
// index.js is required, so both happen at this module's top level, in sequence.
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

import { existsSync } from "fs";
import { createRequire } from "module";
import type { IPty } from "node-pty";
import { dirname } from "path";

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
  import.meta.dir + "/../../node_modules/node-pty/lib/index.js",
  dirname(process.execPath) + "/node_modules/node-pty/lib/index.js",
  process.cwd() + "/node_modules/node-pty/lib/index.js",
];
const _nodePtyPath =
  _nodePtyCandidates.find((p) => existsSync(p)) ?? _nodePtyCandidates[0]!;
const _require = createRequire(_nodePtyPath);

// ─── Patch net.Socket to capture the conin fd (Windows Bun write fix) ────────
// node-pty creates the conin (write-to-shell) socket SYNCHRONOUSLY inside its
// spawn(). This module global holds the fd captured by the most recent such
// creation; startSession snapshots it (via lastConinFd()) immediately after
// ptySpawn() returns so EACH session gets ITS OWN conin fd. (A single module
// global would break the moment one process drives more than one TUI — e.g. the
// daemon — because writes for session #2 would target session #1's now-closed fd.)
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

const { spawn: ptySpawn } = _require("./index.js") as typeof import("node-pty");
const { writeSync: _fsWriteSync } = _require("fs") as typeof import("fs");

export { ptySpawn };

/** The conin fd captured by the most recent ptySpawn(). Snapshot it right away. */
export function lastConinFd(): number | null {
  return _lastConinFd;
}

/**
 * Build a per-session writer bound to THIS pty's captured conin fd. On Windows
 * uses fs.writeSync(coninFd) due to the Bun net.Socket write bug; elsewhere
 * delegates to pty.write.
 */
export function makePtyWriter(pty: IPty, coninFd: number | null) {
  return (data: string): void => {
    if (process.platform === "win32" && coninFd !== null) {
      _fsWriteSync(coninFd, data);
    } else {
      pty.write(data);
    }
  };
}
