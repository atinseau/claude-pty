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
import { CLAUDE_BIN, type Session, startSession } from "./driver";
import {
  createFrameDecoder,
  type Endpoint,
  encodeFrame,
  endpointPath,
  randomToken,
} from "./ipc";
import { WarmPool } from "./pool";
import { prepare, turnTimeoutMs } from "./prepare";
import { signatureOf } from "./signature";

// Bump to invalidate daemons from older builds. M4 will derive this from the
// real package version + the claude binary signature.
const PROTOCOL_VERSION = "m2";
const IDLE_EXIT_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Warm-pool tuning (read from the daemon's env at startup).
const WARM_TARGET = Number(process.env.CLAUDE_PTY_WARM ?? "1"); // per signature
const WARM_MAX = Number(process.env.CLAUDE_PTY_WARM_MAX ?? "4"); // total cap
const WARM_TTL_MS = Number(
  process.env.CLAUDE_PTY_WARM_TTL_MS ?? String(10 * 60_000),
);

/** Everything handleConnection needs from the daemon: pool, warming, breaker. */
interface DaemonCtx {
  pool: WarmPool<Session>;
  onSpawn: () => void;
  ensureWarm: (
    sig: string,
    config: ReturnType<typeof parseArgs>,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void;
}

// ─── Daemon (server) ───────────────────────────────────────────────────────────

export function runDaemon(): void {
  const token = randomToken();
  let active = 0;
  let lastActivity = Date.now();

  // Fork-bomb backstop (defense-in-depth). The root cause — node-pty forking the
  // binary as its conpty agent — is neutralised at the entry point (see
  // handleNodePtyAgentInvocation in main.ts), but a runaway spawn rate should
  // still hard-stop the daemon rather than melt the machine.
  const spawnTimes: number[] = [];
  const onSpawn = () => {
    const now = Date.now();
    spawnTimes.push(now);
    while (spawnTimes.length && now - spawnTimes[0]! > 10_000)
      spawnTimes.shift();
    if (spawnTimes.length > 30) {
      try {
        writeFileSync(
          endpointPath().replace(/daemon\.json$/, "daemon-fuse.log"),
          `tripped at ${new Date(now).toISOString()} (${spawnTimes.length} spawns/10s)\n`,
        );
        rmSync(endpointPath(), { force: true });
      } catch {
        /* ignore */
      }
      process.exit(3);
    }
  };

  // ─── Warm pool: pre-started TUIs keyed by signature (the M3 speedup) ─────────
  const pool = new WarmPool<Session>({
    max: WARM_MAX,
    ttlMs: WARM_TTL_MS,
    now: () => Date.now(),
  });
  const inflight = new Map<string, number>(); // warm spawns in progress per sig
  const inflightTotal = () => {
    let n = 0;
    for (const v of inflight.values()) n += v;
    return n;
  };

  /** Spawn ONE warm TUI for `sig` (multi-turn, idling at the prompt) in background. */
  const warmOne = (
    sig: string,
    config: ReturnType<typeof parseArgs>,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): void => {
    if (pool.size() + inflightTotal() >= WARM_MAX) return;
    const sessionId = crypto.randomUUID();
    const warmConfig = { ...config, message: "", sessionId };
    inflight.set(sig, (inflight.get(sig) ?? 0) + 1);
    onSpawn(); // a warm TUI is a real spawn — count it for the backstop
    const session = startSession(warmConfig, {}, { cwd, env });
    const dec = () =>
      inflight.set(sig, Math.max(0, (inflight.get(sig) ?? 1) - 1));
    session.ready
      .then(() => {
        pool.add({
          sig,
          sessionId,
          bornAt: Date.now(),
          kill: () => session.kill(),
          value: session,
        });
      })
      .catch(() => session.kill())
      .finally(dec);
  };

  const ensureWarm: DaemonCtx["ensureWarm"] = (sig, config, cwd, env) => {
    const have = pool.countFor(sig) + (inflight.get(sig) ?? 0);
    for (let i = have; i < WARM_TARGET; i++) warmOne(sig, config, cwd, env);
  };

  const ctx: DaemonCtx = { pool, onSpawn, ensureWarm };

  const server = createServer((sock) => {
    active++;
    lastActivity = Date.now();
    handleConnection(sock, token, ctx).finally(() => {
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
    pool.evictExpired(); // reap stale warm TUIs even under steady idle
    if (active === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) {
      try {
        pool.clear(); // kill all warm TUIs before exiting
        rmSync(endpointPath(), { force: true });
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
  }, 30_000);
  idle.unref?.();
}

async function handleConnection(
  sock: Socket,
  token: string,
  ctx: DaemonCtx,
): Promise<void> {
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

    const sig = signatureOf({
      cwd,
      bin: CLAUDE_BIN,
      passthrough: config.passthrough,
      env,
    });
    // Poolable = a brand-new session (no --resume/--continue/--session-id): only
    // those can be served by an interchangeable pre-warmed TUI.
    const poolable = sess.mode === "new";
    const warm = poolable ? ctx.pool.take(sig) : null;

    let ptyDone = false;
    let session: Session;
    let driveDeps: Parameters<typeof drive>[2];

    if (warm) {
      // WARM PATH: drive the pre-started, idling TUI. It was spawned multi-turn
      // with its own session id, so inject explicitly (forceInject) and tail that
      // id's transcript. No new TUI spawned ⇒ not counted by the backstop.
      session = warm.value;
      const messages =
        config.inputFormat === "stream-json"
          ? ndjsonMessages
          : [config.message];
      driveDeps = {
        sess: {
          sessionId: warm.sessionId,
          injectSessionId: false,
          mode: "explicit",
        },
        preExisting: null,
        ndjsonMessages: messages,
        ptyDone: () => false,
        cwd,
        turnTimeoutMs: turnTimeoutMs(env),
        forceInject: true,
      };
    } else {
      // COLD PATH: spawn a fresh TUI (M2 behaviour).
      ctx.onSpawn();
      session = startSession(
        config,
        { onTurnDone: () => (ptyDone = true) },
        { cwd, env },
      );
      driveDeps = {
        sess,
        preExisting,
        ndjsonMessages,
        ptyDone: () => ptyDone,
        cwd,
        turnTimeoutMs: turnTimeoutMs(env),
      };
    }

    let code = 1;
    try {
      code = await drive(config, session, driveDeps, { out, err });
    } finally {
      // drive() kills on its normal path; this guarantees the claude.exe tree is
      // reaped even if drive() threw, so the long-lived daemon never orphans a TUI.
      session.kill();
      // Refill the pool for this signature so the NEXT same-signature request is
      // warm (this is what removes the ~659ms spawn→ready on repeated calls).
      if (poolable) ctx.ensureWarm(sig, config, cwd, env);
    }
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
