// src/daemon/client.ts
//
// The daemon CLIENT side: ensure a daemon is up (spawn self detached if needed),
// send the request, relay response frames to stdout/stderr, return the exit code.
// Returns null on ANY failure so the caller falls back to the direct path — the
// daemon is a pure optimization, never a failure point.
//
// Transport + detached-survival approach validated in spike-E-daemon-m0.md.

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { connect } from "net";
import { PROTOCOL_VERSION } from "./identity";
import {
  createFrameDecoder,
  type Endpoint,
  encodeFrame,
  endpointPath,
} from "./protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reconstruct the command to relaunch THIS program (compiled exe or `bun run`). */
function selfCmd(extra: string[]): { cmd: string; args: string[] } {
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith(".ts") || argv1.endsWith(".js"))) {
    return { cmd: process.execPath, args: [argv1, ...extra] };
  }
  return { cmd: process.execPath, args: [...extra] };
}

function readEndpoint(): Endpoint | null {
  try {
    const ep = JSON.parse(readFileSync(endpointPath(), "utf8")) as Endpoint;
    if (ep && typeof ep.port === "number" && ep.token) return ep;
  } catch {
    /* missing / unreadable / malformed */
  }
  return null;
}

/** Connect, send one request, relay response frames; resolve the exit code. */
function exchange(
  ep: Endpoint,
  payload: Record<string, unknown>,
  onOut: (s: string) => void,
  onErr: (s: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const dec = createFrameDecoder();
    let settled = false;
    const sock = connect({ host: "127.0.0.1", port: ep.port }, () => {
      sock.write(encodeFrame({ token: ep.token, ...payload }));
    });
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const f of dec.push(chunk) as Array<Record<string, unknown>>) {
        if (f.s === "o") onOut(f.d as string);
        else if (f.s === "e") onErr(f.d as string);
        else if (f.s === "x") {
          settled = true;
          resolve(typeof f.c === "number" ? f.c : 1);
        }
      }
    });
    sock.on("error", (e) => {
      if (!settled) reject(e);
    });
    sock.on("close", () => {
      if (!settled)
        reject(new Error("daemon closed connection without exit code"));
    });
  });
}

async function probe(ep: Endpoint): Promise<boolean> {
  if (ep.v !== PROTOCOL_VERSION) return false; // stale build → don't use it
  try {
    const code = await exchange(
      ep,
      { argv: ["--help"], cwd: process.cwd(), env: {}, stdin: "" },
      () => {},
      () => {},
    );
    return code === 0;
  } catch {
    return false;
  }
}

function spawnDaemonDetached(): void {
  const { cmd, args } = selfCmd(["--daemon"]);

  if (process.platform === "win32") {
    // Launch the daemon with a HIDDEN CONSOLE, not as a console-less detached
    // process. A console-less daemon makes every console subprocess it (or its
    // descendants — node-pty's agent forks, claude's MCP servers and hooks)
    // spawns pop its own briefly-visible console window. Giving the daemon one
    // hidden console that they all inherit eliminates the flashing (mirroring the
    // direct path, where everything shares the user's existing console).
    // PowerShell Start-Process -WindowStyle Hidden is the reliable way to get
    // that; the launcher PowerShell itself is hidden via windowsHide.
    const psArgList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
    const psCmd =
      `Start-Process -FilePath '${cmd.replace(/'/g, "''")}' -WindowStyle Hidden` +
      (args.length ? ` -ArgumentList ${psArgList}` : "");
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { windowsHide: true, stdio: "ignore" },
    );
    ps.unref();
    return;
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function ensureDaemon(): Promise<Endpoint | null> {
  const existing = readEndpoint();
  if (existing && (await probe(existing))) return existing;

  spawnDaemonDetached();
  for (let i = 0; i < 100; i++) {
    const ep = readEndpoint();
    if (ep && ep.v === PROTOCOL_VERSION && (await probe(ep))) return ep;
    await sleep(50);
  }
  return null;
}

/**
 * Run the request through the daemon. Returns the exit code, or null if the
 * daemon could not be used (caller must then run the direct path).
 */
export async function runViaDaemon(
  argv: string[],
  stdinText: string,
): Promise<number | null> {
  let ep: Endpoint | null;
  try {
    ep = await ensureDaemon();
  } catch {
    return null;
  }
  if (!ep) return null;

  try {
    return await exchange(
      ep,
      {
        argv,
        cwd: process.cwd(),
        env: process.env,
        stdin: stdinText,
      },
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  } catch {
    return null; // fall back to direct
  }
}
