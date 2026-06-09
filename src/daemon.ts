// src/daemon.ts
//
// Optional daemon mode (M2 — plumbing, no warm pool yet). Same single binary in
// two roles:
//   • runDaemon()      — `claude-pty --daemon`: a loopback TCP server that, per
//     request, prepares + drives a session exactly like a direct invocation
//     (shared drive()), relaying output frames back to the client.
//   • runViaDaemon()   — client side: ensure a daemon is up (spawn self detached
//     if needed), send the request, relay frames to stdout/stderr, return the
//     exit code. Returns null on ANY failure so the caller falls back to the
//     direct path — the daemon is a pure optimization, never a failure point.
//
// Transport + detached-survival approach validated in spike-E-daemon-m0.md.

import { spawn } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { connect, createServer, type Socket } from "net";
import { dirname } from "path";
import { helpText, parseArgs } from "./cli";
import { drive } from "./drive";
import { startSession } from "./driver";
import {
  createFrameDecoder,
  type Endpoint,
  encodeFrame,
  endpointPath,
  randomToken,
} from "./ipc";
import { prepare, turnTimeoutMs } from "./prepare";

// Bump to invalidate daemons from older builds. M4 will derive this from the
// real package version + the claude binary signature.
const PROTOCOL_VERSION = "m2";
const IDLE_EXIT_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Daemon (server) ───────────────────────────────────────────────────────────

export function runDaemon(): void {
  const token = randomToken();
  let active = 0;
  let lastActivity = Date.now();

  const server = createServer((sock) => {
    active++;
    lastActivity = Date.now();
    handleConnection(sock, token).finally(() => {
      active--;
      lastActivity = Date.now();
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const ep: Endpoint = {
      port,
      token,
      pid: process.pid,
      v: PROTOCOL_VERSION,
    };
    const p = endpointPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(ep), { mode: 0o600 });
  });

  // Idle self-exit: if nothing has happened for IDLE_EXIT_MS and no request is
  // in flight, remove our endpoint file and exit.
  const idle = setInterval(() => {
    if (active === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) {
      try {
        rmSync(endpointPath(), { force: true });
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
  }, 30_000);
  idle.unref?.();
}

async function handleConnection(sock: Socket, token: string): Promise<void> {
  sock.setEncoding("utf8");
  const dec = createFrameDecoder();
  const out = (s: string) => sock.write(encodeFrame({ s: "o", d: s }));
  const err = (s: string) => sock.write(encodeFrame({ s: "e", d: s }));
  const finish = (code: number) =>
    new Promise<void>((resolve) =>
      sock.end(encodeFrame({ s: "x", c: code }), resolve),
    );

  // One request per connection: resolve once the first complete frame arrives.
  const req = await new Promise<Record<string, unknown> | null>((resolve) => {
    sock.on("data", (chunk: string) => {
      const frames = dec.push(chunk);
      if (frames.length) resolve(frames[0] as Record<string, unknown>);
    });
    sock.on("error", () => resolve(null));
    sock.on("close", () => resolve(null));
  });

  if (!req || req.token !== token) {
    await finish(2);
    return;
  }

  try {
    const argv = (req.argv as string[]) ?? [];
    const cwd = (req.cwd as string) ?? process.cwd();
    const env = (req.env as NodeJS.ProcessEnv) ?? process.env;
    const stdinText = (req.stdin as string) ?? "";

    let config: ReturnType<typeof parseArgs>;
    try {
      config = parseArgs(argv);
    } catch (e) {
      err((e instanceof Error ? e.message : String(e)) + "\n");
      await finish(2);
      return;
    }
    if (config.help) {
      out(helpText());
      await finish(0);
      return;
    }

    const { sess, ndjsonMessages, preExisting } = await prepare(
      config,
      argv,
      stdinText,
      cwd,
    );

    let ptyDone = false;
    const session = startSession(
      config,
      { onTurnDone: () => (ptyDone = true) },
      { cwd, env },
    );
    const code = await drive(
      config,
      session,
      {
        sess,
        preExisting,
        ndjsonMessages,
        ptyDone: () => ptyDone,
        cwd,
        turnTimeoutMs: turnTimeoutMs(env),
      },
      { out, err },
    );
    await finish(code);
  } catch (e) {
    err(`daemon error: ${e instanceof Error ? e.message : String(e)}\n`);
    await finish(1);
  }
}

// ─── Client ────────────────────────────────────────────────────────────────────

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
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
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
