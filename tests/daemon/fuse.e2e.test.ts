// tests/daemon/fuse.e2e.test.ts
//
// The daemon's fork-bomb fuse: >30 spawns in 10s writes daemon-fuse.log, removes
// the endpoint file, and exits the daemon (server.ts). It fires while requests are
// IN FLIGHT, so what matters is not just that it trips but what it leaves behind:
// a corrupted stream, orphaned TUIs, a stale endpoint that poisons later runs?
//
// Reaching it with real sessions would need ~30 concurrent ones (WARM=1 means N−1
// of N concurrent requests spawn cold) — dozens of billed API calls. Two facts make
// it nearly free instead:
//   • the fuse counts SPAWNS, and a warm TUI is a spawn that never calls the API,
//     so one request with CLAUDE_PTY_WARM=35 produces 35 spawns at refill time;
//   • the TUI need not be real claude — a 3-line shell script that emits the
//     prompt-ready signal costs ~1MB instead of ~300MB.
// Result: the fuse trips on 0 API calls.
//
// Opt-in anyway (CLAUDE_PTY_E2E=1): it kills daemons and removes ~/.claude-pty/
// daemon.json, which would disrupt a real daemon the developer is using.

import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const RUN = process.env.CLAUDE_PTY_E2E === "1";

const FUSE_LOG = join(homedir(), ".claude-pty", "daemon-fuse.log");
const ENDPOINT = join(homedir(), ".claude-pty", "daemon.json");

function pids(pattern: string): string[] {
  return new TextDecoder()
    .decode(Bun.spawnSync(["pgrep", "-f", pattern]).stdout)
    .split("\n")
    .filter((l) => l.trim() !== "");
}
const killAll = (pattern: string) => {
  for (const pid of pids(pattern)) Bun.spawnSync(["kill", "-9", pid]);
};

/**
 * A stand-in for claude: emits the prompt-ready signal (U+276F followed by
 * U+00A0, as raw UTF-8 bytes) so the session reaches "ready", then idles. Without
 * that signal the driver waits on session.ready forever.
 */
function fakeClaude(dir: string): string {
  const path = join(dir, "fake-claude");
  writeFileSync(
    path,
    "#!/bin/sh\nprintf '\\342\\235\\257\\302\\240'\nexec sleep 3600\n",
  );
  chmodSync(path, 0o755);
  return path;
}

test.skipIf(!RUN)(
  "the fork-bomb fuse trips, and leaves nothing broken behind",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-fuse-"));
    const fake = fakeClaude(cwd);

    killAll("main.ts --daemon"); // a pre-existing daemon would serve the request
    rmSync(FUSE_LOG, { force: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined) env[k] = v;
    env.CLAUDE_PTY_DAEMON = "1";
    env.CLAUDE_PTY_BIN = fake;
    env.CLAUDE_PTY_WARM = "35"; // 35 warm spawns at refill → over the 30/10s limit
    env.CLAUDE_PTY_WARM_MAX = "35";
    env.CLAUDE_PTY_TURN_TIMEOUT_MS = "6000";

    const p = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "../../src/main.ts"),
        "--output-format",
        "json",
        "hello",
      ],
      { cwd, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);

    try {
      // The fuse tripped, and recorded why.
      expect(existsSync(FUSE_LOG)).toBe(true);
      expect(readFileSync(FUSE_LOG, "utf8")).toContain("spawns/10s");

      // The request fails loudly rather than returning a partial success.
      expect(code).not.toBe(0);
      // stdout carries no half-written result envelope.
      expect(stdout.trim()).toBe("");
      expect(stderr.length).toBeGreaterThan(0);

      // The endpoint file is gone, so the next run starts a fresh daemon instead
      // of dialling a dead one.
      expect(existsSync(ENDPOINT)).toBe(false);

      // Nothing is orphaned: the dying daemon's fds close, hanging up every pty.
      const deadline = Date.now() + 15_000;
      while (pids("sleep 3600").length > 0 && Date.now() < deadline)
        await Bun.sleep(250);
      expect(pids("sleep 3600")).toEqual([]);
      expect(pids("main.ts --daemon")).toEqual([]);
    } finally {
      killAll("sleep 3600");
      killAll("main.ts --daemon");
      rmSync(FUSE_LOG, { force: true });
    }
  },
  120_000,
);
