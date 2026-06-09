# Spike E — Daemon M0: single-binary detached self-relaunch + loopback IPC

**Status:** GO. Both technical unknowns proven, for `bun run` AND the
`bun build --compile` single binary on Windows.
**Runtime:** Bun 1.3.14, Windows 11 (win32 x64).
**Date:** 2026-06-09
**Scaffolding:** `spike/daemon-spike.ts` (throwaway, kept as the GO/NO-GO record;
not the real daemon).

## Why this spike

The daemon optimization (warm-pool of pre-started TUIs to remove the ~659 ms
spawn→ready tax on repeated calls) only makes sense if two things are possible
WITHOUT shipping a second executable (project rule #1: a single binary):

1. **Detached, surviving self-relaunch.** The same binary, invoked with a
   `--daemon` flag, must keep running after the client process that launched it
   has exited — including when it IS the compiled binary relaunching itself via
   `process.execPath`.
2. **IPC.** A client and the daemon must talk over a portable, secure channel.

If either failed, the daemon approach would be off the table (or require a
separate artifact). This spike answers GO/NO-GO before any production code.

## Method

`spike/daemon-spike.ts` is the same program in three modes (selected by argv):

- default → **client**: ensure a daemon is up (spawn self detached if not),
  connect, send one token-authenticated `ping`, print the daemon PID + uptime.
- `--daemon` → **daemon**: listen on `127.0.0.1:0` (ephemeral port), write
  `{port, token, pid}` to `os.tmpdir()/claude-pty-spike.json` (mode 0600), append
  a `heartbeat` line every second, idle-exit after 90 s.
- `--shutdown` → tell the daemon to exit (cleanup).

Deliberately uses `node:net` + `node:child_process` (`spawn(cmd, args,
{ detached: true, stdio: "ignore", windowsHide: true })` then `child.unref()`)
so the result reflects OS/runtime capability, not a Bun-API quirk. Self-relaunch
command is reconstructed for both shapes: `bun run x.ts` → `[bun, x.ts, --daemon]`;
compiled `x.exe` → `[x.exe, --daemon]`.

Survival is proven by running the client as **separate OS processes** with gaps
between them: if client #2 (a brand-new process, after client #1 fully exited and
its Bash command torn down) reaches the **same daemon PID** with a larger uptime,
the daemon outlived its launcher.

## Results

### `bun run` mode

```
CLIENT #1: daemonPid=13552 uptimeMs=29   connectMs=64   (cold: spawned the daemon)
CLIENT #2: daemonPid=13552 uptimeMs=9651 connectMs=5    (warm: same daemon, new process)
CLIENT #3: daemonPid=13552 uptimeMs=9716 connectMs=5
heartbeat log: pid=13552 every ~1 s, continuous across all three client runs
```

### Compiled single binary (`cp-daemon-spike.exe`) — the production shape

```
CLIENT #1: daemonPid=6576 uptimeMs=37   connectMs=69   (cold)
CLIENT #2: daemonPid=6576 uptimeMs=8981 connectMs=5    (warm, separate process)
CLIENT #3: daemonPid=6576 uptimeMs=9038 connectMs=5
tasklist /FI "PID eq 6576": cp-daemon-spike.exe  6576  Console  ~56 MB  ← real standalone OS process
--shutdown: {"ok":true,"bye":true}
```

## Conclusions

- **GO.** A single compiled binary can relaunch itself as a detached daemon that
  survives client exit (confirmed against the OS task list, not just same-PID
  reconnects), and a loopback-TCP + shared-token IPC works.
- **Warm reconnect is ~5 ms** vs ~65 ms to cold-spawn the daemon. (This is just
  the IPC handshake; the real ~659 ms saving comes later from the warm TUI pool,
  not measured here.)
- Endpoint discovery via a tmpdir file (`{port, token, pid}`, 0600) is enough;
  a stale file is handled by a reachability probe before reuse.

## Carry-forward for the real implementation

- **Transport:** loopback TCP + token (chosen over Windows named pipes for Bun
  portability). Bind 127.0.0.1 only; token in a 0600 file.
- **Memory:** the bare daemon is ~56 MB. Each warm **TUI** in the pool adds
  ~200 MB — cap the pool small (default 1–2) and key it by signature.
- **Lifecycle still to build (M4):** idle-exit (spike uses a crude 90 s timer),
  crash/stale-endpoint recovery, concurrency, pool eviction, claude-version
  invalidation, and a "really at the ❯ prompt" health-check before reusing a
  warm TUI.
- **Detach recipe that works:** `node:child_process.spawn(..., { detached: true,
  stdio: "ignore", windowsHide: true })` + `child.unref()`; relaunch target is
  `process.execPath` (+ the script path only under `bun run`).
