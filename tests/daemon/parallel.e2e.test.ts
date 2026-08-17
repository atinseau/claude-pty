// tests/daemon/parallel.e2e.test.ts
//
// End-to-end behaviour of the DAEMON under concurrency — the questions unit tests
// on pool.ts / logic.ts cannot answer, because they never spawn a real TUI:
//
//   • Does each concurrent request get ITS OWN answer? (a shared warm pool +
//     transcripts landing in one project dir is exactly where answers could cross)
//   • Does resuming those sessions in parallel keep each context isolated?
//   • Does the daemon leak claude processes under load — and does killing it
//     leave its warm TUIs orphaned?
//
// Real API calls, so it is opt-in like tests/golden.test.ts: CLAUDE_PTY_E2E=1.
//
// Process accounting — the part that is easy to get wrong. node-pty spawns each
// TUI through `spawn-helper`, but that helper exec()s the claude binary, so its
// argv is GONE by the time the TUI is running: counting "spawn-helper" processes
// yields 0 no matter what, and every leak assertion built on it passes for free.
// A live TUI carries claude's own argv, recognisable by the `--session-id`
// claude-pty passes it (and no `--settings`, which the user's own Claude Code
// sessions carry). Pre-existing matches are snapshotted and subtracted, so only
// processes THIS test created are ever counted.
//
// Note the `--` in the pgrep call: without it, pgrep reads the "--session-id"
// pattern as an option, fails with "illegal option", and silently reports zero.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const RUN = process.env.CLAUDE_PTY_E2E === "1";

/** Concurrent sessions per phase. */
const N = 8;

/** Isolated cwd: keeps the transcripts and the process accounting to this test. */
const CWD = mkdtempSync(join(tmpdir(), "cp-daemon-par-"));

const TURN_TIMEOUT_MS = "180000";

function daemonEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.CLAUDE_PTY_DAEMON = "1";
  env.CLAUDE_PTY_TURN_TIMEOUT_MS = TURN_TIMEOUT_MS;
  return env;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run claude-pty from CWD with the daemon enabled. */
async function runPty(args: string[]): Promise<Run> {
  const p = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "../../src/main.ts"), ...args],
    {
      cwd: CWD,
      env: daemonEnv(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/** The `result` envelope from a --output-format json run. */
function resultOf(r: Run): {
  result: string;
  session_id: string;
  is_error: boolean;
} {
  const line = r.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line);
}

/** Every claude TUI driven by a claude-pty (anywhere on this machine). */
function allPtyTuiPids(): string[] {
  const r = Bun.spawnSync(["pgrep", "-fl", "--", "--session-id"]);
  return new TextDecoder()
    .decode(r.stdout)
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.includes("--settings"))
    .map((l) => l.trim().split(/\s+/)[0]!);
}

/** TUIs that pre-date this test — subtracted from every count below. */
const PRE_EXISTING = new Set(RUN ? allPtyTuiPids() : []);

/** PIDs of TUIs THIS test is responsible for. */
function ourTuiPids(): string[] {
  return allPtyTuiPids().filter((pid) => !PRE_EXISTING.has(pid));
}

function isAlive(pid: string): boolean {
  return Bun.spawnSync(["kill", "-0", pid]).exitCode === 0;
}

function daemonPids(): string[] {
  const r = Bun.spawnSync([
    "pgrep",
    "-f",
    "claude-pty.*--daemon|main.ts --daemon",
  ]);
  return new TextDecoder()
    .decode(r.stdout)
    .split("\n")
    .filter((l) => l.trim() !== "");
}

async function until(probe: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe() && Date.now() < deadline) await Bun.sleep(250);
}

/** session_id → the token that session was told to reply with. */
const plantedTokens = new Map<string, string>();

afterAll(() => {
  if (!RUN) return;
  // Never leave this test's TUIs (or the daemon it started) behind.
  for (const pid of ourTuiPids()) Bun.spawnSync(["kill", "-9", pid]);
  for (const pid of daemonPids()) Bun.spawnSync(["kill", "-9", pid]);
});

// The very first run in a fresh directory meets the workspace-trust dialog. Get
// it out of the way sequentially: N concurrent first-runs would each answer that
// dialog and race on ~/.claude.json, which would muddy every later assertion.
test.skipIf(!RUN)(
  "accepts the workspace-trust dialog and starts the daemon",
  async () => {
    const r = await runPty([
      "--output-format",
      "json",
      "Reply with exactly: READY",
    ]);

    expect(r.code).toBe(0);
    expect(resultOf(r).result.trim()).toBe("READY");
    expect(daemonPids().length).toBeGreaterThanOrEqual(1);
  },
  240_000,
);

test.skipIf(!RUN)(
  `${N} concurrent daemon sessions each get their own answer`,
  async () => {
    // Nonce per run, so a token can never be recalled from an earlier run's
    // transcript rather than this one's.
    const nonce = crypto.randomUUID().slice(0, 8);
    const tokens = Array.from({ length: N }, (_, i) => `TOKEN-${i}-${nonce}`);

    const runs = await Promise.all(
      tokens.map((t) =>
        runPty(["--output-format", "json", `Reply with exactly: ${t}`]),
      ),
    );

    const results = runs.map(resultOf);
    results.forEach((res, i) => {
      plantedTokens.set(res.session_id, tokens[i]!);
    });

    // Every run succeeded...
    expect(runs.map((r) => r.code)).toEqual(Array(N).fill(0));
    expect(results.map((r) => r.is_error)).toEqual(Array(N).fill(false));
    // ...each answer is ITS OWN token, in order — a crossed answer fails here...
    expect(results.map((r) => r.result.trim())).toEqual(tokens);
    // ...no answer carries another session's token (crossing that also matched
    // its own, e.g. concatenated transcripts)...
    results.forEach((res, i) => {
      for (const [j, other] of tokens.entries()) {
        if (i !== j) expect(res.result).not.toContain(other);
      }
    });
    // ...and every session is distinct.
    expect(new Set(results.map((r) => r.session_id)).size).toBe(N);
  },
  600_000,
);

test.skipIf(!RUN)(
  `resuming ${N} sessions in parallel keeps each context isolated`,
  async () => {
    const ids = [...plantedTokens.keys()];
    expect(ids.length).toBe(N); // guard: depends on the previous test

    const runs = await Promise.all(
      ids.map((id) =>
        runPty([
          "--resume",
          id,
          "--output-format",
          "json",
          "What token did I ask you to reply with? Reply with exactly that token, nothing else.",
        ]),
      ),
    );

    runs.forEach((r, i) => {
      const id = ids[i]!;
      expect(r.code).toBe(0);
      // Each resumed session recalls ITS OWN token: proof the parallel resumes
      // tailed the right transcript and did not read each other's turns.
      expect(resultOf(r).result).toContain(plantedTokens.get(id)!);
    });
  },
  600_000,
);

test.skipIf(!RUN)(
  "no TUI is left running once the concurrent requests are done",
  async () => {
    // Warm TUIs are kept ON PURPOSE (that is the pool), capped by
    // CLAUDE_PTY_WARM_MAX (default 4). Anything beyond that cap is a leak.
    await until(() => ourTuiPids().length <= 4, 30_000);

    expect(ourTuiPids().length).toBeLessThanOrEqual(4);
  },
  60_000,
);

test.skipIf(!RUN)(
  "killing the daemon leaves no orphaned TUI behind",
  async () => {
    // The pool refills after each poolable request, so warm TUIs exist by now.
    // Assert that FIRST: with an empty pool this test would "pass" without ever
    // exercising an orphan — exactly the trap to avoid when measuring a leak.
    await until(() => ourTuiPids().length > 0, 20_000);
    const warmBeforeKill = ourTuiPids();
    expect(warmBeforeKill.length).toBeGreaterThan(0);

    const daemons = daemonPids();
    expect(daemons.length).toBeGreaterThanOrEqual(1);

    // SIGKILL, not SIGTERM: the daemon cannot run pool.clear() on its way out, so
    // this is what a crash (or `kill -9` by an impatient user) actually leaves.
    // Survival is possible in principle — the TUIs are reparented to init, not
    // signalled — and is prevented only because the dying daemon's fds close,
    // hanging up each pty master. That is the invariant under test.
    for (const pid of daemons) Bun.spawnSync(["kill", "-9", pid]);
    await until(() => !warmBeforeKill.some(isAlive), 30_000);

    expect(warmBeforeKill.filter(isAlive)).toEqual([]);
  },
  60_000,
);
