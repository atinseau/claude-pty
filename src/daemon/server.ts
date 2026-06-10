// src/daemon/server.ts
//
// The daemon SERVER: `claude-pty --daemon`. A loopback TCP server that, per
// request, prepares + drives a session exactly like a direct invocation (shared
// drive()), relaying output frames back to the client. Holds the warm pool of
// pre-started TUIs (the M3 speedup) and the fork-bomb backstop.
//
// The client half lives in ./client; the wire framing + endpoint file in
// ./protocol; the build-identity probe is shared via ./identity.

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer, type Socket } from "net";
import { dirname } from "path";
import { parseArgs } from "../cli/args";
import { helpText } from "../cli/help";
import { CLAUDE_BIN, type Session, startSession } from "../pty/session";
import { drive } from "../run/drive";
import {
  MISSING_INPUT_ERROR,
  missingInput,
  prepare,
  turnTimeoutMs,
} from "../run/prepare";
import { PROTOCOL_VERSION } from "./identity";
import { takeLiveWarm, warmMessages, warmSess } from "./logic";
import { WarmPool } from "./pool";
import {
  createFrameDecoder,
  type Endpoint,
  encodeFrame,
  endpointPath,
  randomToken,
} from "./protocol";
import { signatureOf } from "./signature";

const IDLE_EXIT_MS = 5 * 60_000;

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

    // Settle exactly once: pool it if it reaches the prompt, else kill it. The
    // timeout guards the case where the TUI dies or hangs BEFORE ready (the ready
    // promise then never settles), which would otherwise leak inflight + process.
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      inflight.set(sig, Math.max(0, (inflight.get(sig) ?? 1) - 1));
      action();
    };
    session.ready
      .then(() =>
        settle(() =>
          pool.add({
            sig,
            sessionId,
            bornAt: Date.now(),
            kill: () => session.kill(),
            value: session,
          }),
        ),
      )
      .catch(() => settle(() => session.kill()));
    setTimeout(() => settle(() => session.kill()), 20_000).unref?.();
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

    // Nothing to submit: fail fast like `claude -p` (same guard as direct mode).
    if (missingInput(config, sess)) {
      err(MISSING_INPUT_ERROR + "\n");
      await finish(1);
      return;
    }

    const sig = signatureOf({
      cwd,
      bin: CLAUDE_BIN,
      passthrough: config.passthrough,
      env,
    });
    // Poolable = a brand-new session (no --resume/--continue/--session-id): only
    // those can be served by an interchangeable pre-warmed TUI.
    const poolable = sess.mode === "new";
    const warm = poolable ? takeLiveWarm(ctx.pool, sig) : null;

    let ptyDone = false;
    let session: Session;
    let driveDeps: Parameters<typeof drive>[2];

    if (warm) {
      // WARM PATH: drive the pre-started, idling TUI. It was spawned multi-turn
      // with its own session id, so inject explicitly (forceInject) and tail that
      // id's transcript. No new TUI spawned ⇒ not counted by the backstop.
      session = warm.value;
      driveDeps = {
        sess: warmSess(warm.sessionId),
        preExisting: null,
        ndjsonMessages: warmMessages(
          config.inputFormat,
          config.message,
          ndjsonMessages,
        ),
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
