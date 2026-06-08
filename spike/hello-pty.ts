// spike/hello-pty.ts
//
// PURPOSE: Prove that node-pty works under `bun run` AND under a
// `bun build --compile`-produced binary. This is the GO/NO-GO gate
// for the entire claude-pty project.
//
// PLATFORM NOTES (Windows / ConPTY):
//   - We use cmd.exe instead of powershell.exe as the pty shell.
//     PowerShell takes 1-2 s to start inside a pty and its prompt can be
//     very noisy (ANSI escape sequences, newlines, version banners), which
//     makes it hard to reliably detect "hello-from-pty" in the output.
//     cmd.exe starts instantly and produces clean output.
//   - `echo hello-from-pty\r\n` works in cmd.exe.
//   - `exit\r\n` works in both cmd.exe and powershell.exe.
//
// TWO INCOMPATIBILITIES FOUND — BOTH RESOLVED:
//
// 1) BUN + net.Socket WRITE BUG (Windows only):
//    node-pty opens the ConPTY conin pipe as a Windows HANDLE and wraps it
//    in `net.Socket({fd, readable:false, writable:true})`. Bun v1.x does NOT
//    support fd-based writable `net.Socket` writes: `socket.write()` returns
//    false and throws "Socket is closed" even though the fd is valid and open.
//
//    ROOT CAUSE: Bun's net.Socket never leaves "pending" state for fd-based
//    write-only sockets (no TCP connection to establish), so all writes are
//    buffered forever and then rejected.
//
//    WORKAROUND: Capture the conin fd by monkey-patching `net.Socket` BEFORE
//    node-pty loads, then write using `fs.writeSync(fd, data)` directly.
//    The outSocket (data/read path) works fine without patching.
//    This workaround must be applied in the real pty-driver module.
//
// 2) bun --compile + createRequire MODULE RESOLUTION:
//    Static `import` from node-pty would cause Bun to bundle its CJS code,
//    which prevents the `net.Socket` patch from being applied first.
//    We use `createRequire` instead, loading node-pty dynamically (after
//    the patch). However, inside a compiled binary `createRequire("pkg")`
//    does not walk up from the virtual B:\~BUN root to find node_modules.
//
//    WORKAROUND: Use the absolute CWD path to node-pty's entry point as
//    the `createRequire` base. This resolves from the actual filesystem
//    where the binary is run, not from Bun's internal virtual path.
//      createRequire(process.cwd() + "/node_modules/node-pty/lib/index.js")
//
//    The compiled binary still requires `node_modules/node-pty/` to exist
//    in (or above) the CWD at runtime — acceptable since this project is
//    distributed via `bun install`, not as a standalone single-file exe.
//    The `.node` native addons are loaded by node-pty's own loadNativeModule()
//    via `../prebuilds/<platform>-<arch>/` relative to its lib/ directory,
//    which resolves correctly from node_modules — no separate sidecar needed.
//
// SUMMARY OF GO/NO-GO FINDINGS:
//   GO  — `bun run spike/hello-pty.ts`: works with patches
//   GO  — compiled `spike-hello.exe` (run from project root): works with
//         node_modules/node-pty/ present in CWD
//   CONSTRAINT: the compiled binary requires node_modules/node-pty/ in CWD.
//   VERDICT: Project can proceed; all planned usages involve `bun install`.

import { createRequire } from "module";

// Load all CJS modules via a require rooted at CWD so the compiled binary
// can find node_modules when node_modules/ is next to the binary's run dir.
const _nodePtyPath = process.cwd() + "/node_modules/node-pty/lib/index.js";
const _require = createRequire(_nodePtyPath);

// ─── Patch net.Socket to capture the conin fd (Windows Bun write fix) ────────
let _coninFd: number | null = null;

if (process.platform === "win32") {
  const net = _require("net");
  const OrigSocket = net.Socket;
  net.Socket = function PatchedSocket(opts?: { fd?: number; readable?: boolean; writable?: boolean }) {
    // node-pty creates the inSocket (write-to-shell pipe) with this shape:
    if (opts && typeof opts.fd === "number" && opts.readable === false && opts.writable === true) {
      _coninFd = opts.fd;
    }
    return new OrigSocket(opts);
  };
  net.Socket.prototype = OrigSocket.prototype;
}
// ─────────────────────────────────────────────────────────────────────────────

// Load node-pty AFTER the patch so its module init sees our PatchedSocket.
const { spawn } = _require("./index.js") as typeof import("node-pty");
const { writeSync } = _require("fs") as typeof import("fs");

const shell = process.platform === "win32" ? "cmd.exe" : "bash";
const pty = spawn(shell, [], { cols: 120, rows: 30 });

/** Write to the pty — uses fs.writeSync on Windows due to Bun net.Socket bug. */
function ptyWrite(data: string): void {
  if (process.platform === "win32" && _coninFd !== null) {
    writeSync(_coninFd, data);
  } else {
    pty.write(data);
  }
}

let out = "";
let exited = false;

pty.onData((d) => { out += d; process.stdout.write(d); });
pty.onExit(({ exitCode }) => {
  exited = true;
  console.log(`\n[spike] exited ${exitCode}; captured ${out.length} bytes`);
  process.exit(out.length > 0 ? 0 : 1);
});

// Give cmd.exe 800 ms to start and display its prompt, then drive it.
setTimeout(() => {
  if (!exited) ptyWrite("echo hello-from-pty\r\n");
  setTimeout(() => { if (!exited) ptyWrite("exit\r\n"); }, 1000);
}, 800);
