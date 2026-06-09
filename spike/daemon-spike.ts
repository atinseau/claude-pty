// spike/daemon-spike.ts
//
// M0 de-risking spike for the claude-pty daemon. Proves the two technical
// unknowns BEFORE committing to the real implementation:
//
//   1) SINGLE BINARY, DETACHED & SURVIVING: the program can relaunch ITSELF as a
//      daemon (same executable, just a `--daemon` flag) that keeps running after
//      the client process that started it has exited — including when run as a
//      `bun build --compile` binary on Windows (the production shape).
//
//   2) IPC: a loopback TCP + shared-token channel works between client and
//      daemon (bind 127.0.0.1 only, ephemeral port, token in a 0600 file).
//
// This is throwaway scaffolding (cf. spike/hello-pty.ts) — NOT the real daemon.
// It deliberately uses node:net + node:child_process (well-understood detach &
// socket semantics) rather than Bun-native APIs, so the GO/NO-GO result is about
// the OS/runtime capability, not an API quirk.
//
// Modes:
//   <program>             → client: ensure a daemon is up, connect, ping, print
//   <program> --daemon    → run as the daemon (listen + endpoint file + heartbeat)
//   <program> --shutdown  → ask the running daemon to exit (cleanup)

import { spawn } from "child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { connect, createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

const ENDPOINT = join(tmpdir(), "claude-pty-spike.json");
const HEARTBEAT = join(tmpdir(), "claude-pty-spike-heartbeat.log");

function hlog(msg: string): void {
  appendFileSync(
    HEARTBEAT,
    `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`,
  );
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Endpoint {
  port: number;
  token: string;
  pid: number;
}

// ─── Reconstruct the command that relaunches THIS program with extra args ──────
// Works for both shapes:
//   bun run spike/x.ts        → argv = [bun, /abs/x.ts, ...] → cmd=bun, prepend script
//   compiled  x.exe           → argv = [x.exe, ...userArgs]  → cmd=x.exe (no script)
function selfCmd(extra: string[]): { cmd: string; args: string[] } {
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith(".ts") || argv1.endsWith(".js"))) {
    return { cmd: process.execPath, args: [argv1, ...extra] };
  }
  return { cmd: process.execPath, args: [...extra] };
}

// ─── Transport: send one JSON request, await one JSON response line ────────────
function request(
  port: number,
  payload: Record<string, unknown>,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify(payload) + "\n");
    });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("request timeout"));
    }, timeoutMs);
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        sock.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e as Error);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function reachable(ep: Endpoint): Promise<boolean> {
  try {
    const r = await request(ep.port, { token: ep.token, cmd: "ping" }, 500);
    return r.ok === true;
  } catch {
    return false;
  }
}

// ─── Daemon ────────────────────────────────────────────────────────────────────
function runDaemon(): void {
  const token = randomToken();
  const started = Date.now();
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        sock.end();
        return;
      }
      if (req.token !== token) {
        sock.write(JSON.stringify({ error: "bad token" }) + "\n");
        sock.end();
        return;
      }
      if (req.cmd === "shutdown") {
        hlog("shutdown requested");
        sock.write(JSON.stringify({ ok: true, bye: true }) + "\n");
        sock.end(() => process.exit(0));
        return;
      }
      sock.write(
        JSON.stringify({
          ok: true,
          daemonPid: process.pid,
          uptimeMs: Date.now() - started,
          echo: req.msg ?? null,
        }) + "\n",
      );
      sock.end();
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeFileSync(
      ENDPOINT,
      JSON.stringify({ port, token, pid: process.pid }),
      { mode: 0o600 },
    );
    hlog(`daemon listening on 127.0.0.1:${port}`);
  });

  setInterval(() => hlog("heartbeat"), 1000);
  // Spike safety net: never linger more than 90s.
  setTimeout(() => {
    hlog("idle exit");
    process.exit(0);
  }, 90_000).unref?.();
}

// ─── Client ──────────────────────────────────────────────────────────────────
function spawnDaemonDetached(): void {
  const { cmd, args } = selfCmd(["--daemon"]);
  hlog(`client ${process.pid} spawning daemon: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function ensureDaemon(): Promise<Endpoint> {
  if (existsSync(ENDPOINT)) {
    try {
      const ep = JSON.parse(readFileSync(ENDPOINT, "utf8")) as Endpoint;
      if (await reachable(ep)) return ep;
    } catch {
      /* stale endpoint file — fall through and respawn */
    }
  }
  spawnDaemonDetached();
  for (let i = 0; i < 100; i++) {
    if (existsSync(ENDPOINT)) {
      try {
        const ep = JSON.parse(readFileSync(ENDPOINT, "utf8")) as Endpoint;
        if (await reachable(ep)) return ep;
      } catch {
        /* not ready yet */
      }
    }
    await sleep(50);
  }
  throw new Error("daemon did not come up within 5s");
}

async function runClient(): Promise<void> {
  const t0 = Date.now();
  const ep = await ensureDaemon();
  const res = await request(ep.port, {
    token: ep.token,
    cmd: "ping",
    msg: `hello from client ${process.pid}`,
  });
  console.log(
    `CLIENT ok: daemonPid=${res.daemonPid} uptimeMs=${res.uptimeMs} ` +
      `connectMs=${Date.now() - t0} echo=${JSON.stringify(res.echo)}`,
  );
}

async function runShutdown(): Promise<void> {
  if (!existsSync(ENDPOINT)) {
    console.log("no endpoint file; daemon not running");
    return;
  }
  const ep = JSON.parse(readFileSync(ENDPOINT, "utf8")) as Endpoint;
  try {
    const r = await request(ep.port, { token: ep.token, cmd: "shutdown" });
    console.log(`shutdown: ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`shutdown failed (daemon likely already down): ${e}`);
  }
}

// ─── Entry ─────────────────────────────────────────────────────────────────────
const mode = process.argv.includes("--daemon")
  ? "daemon"
  : process.argv.includes("--shutdown")
    ? "shutdown"
    : "client";

if (mode === "daemon") runDaemon();
else if (mode === "shutdown") await runShutdown();
else await runClient();
