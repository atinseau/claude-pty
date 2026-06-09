// scripts/bench.ts
//
// Real end-to-end benchmark for claude-pty.
//
// Measures, against the live `claude` binary (real API calls):
//   • claude-pty total latency   (process start → exit, --output-format json)
//   • claude-pty time-to-first-event  (start → first stdout line, stream-json)
//   • claude -p   total latency   (headless baseline, same prompt)
//   • phase breakdown: spawn → TUI-ready (the interactive-startup tax), measured
//     in-process via the driver hooks.
//
// Every spawned child has the "running inside Claude Code" env signals scrubbed
// (CLAUDECODE / CLAUDE_CODE_*), so the benchmark is valid even when run from
// within a Claude Code session — otherwise the child TUI would not persist a
// transcript and every claude-pty run would hang to its turn timeout.
//
// Usage:
//   bun run scripts/bench.ts [--reps N] [--prompt "..."] [--no-baseline]
//
// Env:
//   CLAUDE_PTY_BIN   path to the claude binary to drive (forwarded to children)
//   BENCH_BIN        path to a prebuilt claude-pty binary to measure
//                    (default: build a throwaway one with `bun build --compile`)

import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseArgs } from "../src/cli";
import { startSession } from "../src/driver";

// ─── args ────────────────────────────────────────────────────────────────────
const argv = Bun.argv.slice(2);
function flag(name: string, def: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
}
const REPS = Number(flag("--reps", "3"));
const PROMPT = flag("--prompt", "say only the word: ok");
const RUN_BASELINE = !argv.includes("--no-baseline");

// ─── scrubbed child env ────────────────────────────────────────────────────────
const CHILD_ENV: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
  CHILD_ENV[k] = v;
}
const CLAUDE_BIN =
  process.env.CLAUDE_PTY_BIN ?? "C:\\Users\\arthur\\.local\\bin\\claude.exe";

// ─── stats ─────────────────────────────────────────────────────────────────────
interface Stats {
  min: number;
  med: number;
  max: number;
}
function stats(xs: number[]): Stats {
  const s = xs.slice().sort((a, b) => a - b);
  return {
    min: s[0] ?? 0,
    med: s[Math.floor(s.length / 2)] ?? 0,
    max: s[s.length - 1] ?? 0,
  };
}
function row(label: string, st: Stats, runs: number[]): string {
  const r = runs.map((n) => `${Math.round(n)}`).join(", ");
  return `${label.padEnd(34)} med=${String(Math.round(st.med)).padStart(5)}ms  min=${String(Math.round(st.min)).padStart(5)}ms  max=${String(Math.round(st.max)).padStart(5)}ms   [${r}]`;
}

// ─── timing helpers ────────────────────────────────────────────────────────────
const now = () => Number(Bun.nanoseconds()) / 1e6;

/** Spawn a child, measure total ms and (optionally) ms to first stdout byte. */
async function timeChild(
  cmd: string[],
  measureFirstByte: boolean,
): Promise<{ total: number; firstByte: number; ok: boolean }> {
  const t0 = now();
  const proc = Bun.spawn(cmd, {
    env: CHILD_ENV,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let firstByte = -1;
  if (measureFirstByte) {
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    if (value && value.length > 0) firstByte = now() - t0;
    reader.releaseLock();
  }
  const code = await proc.exited;
  const total = now() - t0;
  return { total, firstByte, ok: code === 0 };
}

/**
 * In-process phase breakdown: process start → TUI prompt ready.
 *
 * Uses multi-turn mode (no positional message ⇒ config.message === "") so the
 * driver does NOT schedule an auto-injection — otherwise killing the pty at
 * onReady would race the pending inject timer and write to a dead pty.
 */
function timeSpawnToReady(): Promise<number> {
  return new Promise((resolve) => {
    const config = parseArgs(["--output-format", "text"]);
    const t0 = now();
    const sess = startSession(config, {
      onReady: () => {
        const ms = now() - t0;
        sess.pty.kill();
        resolve(ms);
      },
    });
  });
}

// ─── resolve the claude-pty binary under test ─────────────────────────────────
async function resolveBin(): Promise<string> {
  const fromEnv = process.env.BENCH_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const out = join(tmpdir(), `claude-pty-bench${process.platform === "win32" ? ".exe" : ""}`);
  process.stdout.write(`Building benchmark binary → ${out} ...\n`);
  const build = Bun.spawn(
    ["bun", "build", "src/main.ts", "--compile", "--outfile", out],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await build.exited) !== 0) throw new Error("build failed");
  return out;
}

// ─── run ───────────────────────────────────────────────────────────────────────
const PTY_BIN = await resolveBin();
process.stdout.write(
  `\nclaude-pty benchmark\n  reps=${REPS}  prompt=${JSON.stringify(PROMPT)}  baseline=${RUN_BASELINE}\n  pty-bin=${PTY_BIN}\n  claude=${CLAUDE_BIN}\n\n`,
);

const ptyTotal: number[] = [];
const ptyFirst: number[] = [];
const spawnReady: number[] = [];
const baseTotal: number[] = [];

for (let i = 0; i < REPS; i++) {
  process.stdout.write(`rep ${i + 1}/${REPS} ... `);

  const ready = await timeSpawnToReady();
  spawnReady.push(ready);

  const e2e = await timeChild([PTY_BIN, "--output-format", "json", PROMPT], false);
  ptyTotal.push(e2e.total);

  const stream = await timeChild(
    [PTY_BIN, "--output-format", "stream-json", PROMPT],
    true,
  );
  if (stream.firstByte > 0) ptyFirst.push(stream.firstByte);

  if (RUN_BASELINE) {
    const base = await timeChild(
      [CLAUDE_BIN, "-p", "--output-format", "json", PROMPT],
      false,
    );
    baseTotal.push(base.total);
  }
  process.stdout.write(
    `pty-total=${Math.round(e2e.total)}ms  pty-first-event=${Math.round(stream.firstByte)}ms  spawn→ready=${Math.round(ready)}ms${RUN_BASELINE ? `  -p=${Math.round(baseTotal[i] ?? 0)}ms` : ""}\n`,
  );
}

process.stdout.write("\n=== results ===\n");
process.stdout.write(row("claude-pty total (json)", stats(ptyTotal), ptyTotal) + "\n");
if (ptyFirst.length)
  process.stdout.write(
    row("claude-pty first event (stream)", stats(ptyFirst), ptyFirst) + "\n",
  );
process.stdout.write(
  row("  └ phase: spawn → TUI ready", stats(spawnReady), spawnReady) + "\n",
);
if (RUN_BASELINE)
  process.stdout.write(row("claude -p total (baseline)", stats(baseTotal), baseTotal) + "\n");

if (RUN_BASELINE && ptyTotal.length && baseTotal.length) {
  const overhead = stats(ptyTotal).med - stats(baseTotal).med;
  process.stdout.write(
    `\nclaude-pty overhead vs -p (median): ${Math.round(overhead)}ms\n`,
  );
}
process.exit(0);
