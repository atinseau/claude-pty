// tests/cli/no-input.test.ts
//
// e2e: `claude-pty` with no prompt argument and no piped stdin must fail fast
// with a `claude -p`-style missing-input error (exit 1) — NOT spawn a TUI
// that idles until the turn timeout. The message must not mention --print:
// claude-pty bans that flag. Runs ungated: the error path never reaches the
// claude binary. CLAUDE_PTY_TURN_TIMEOUT_MS is a regression guard so a broken
// build fails in seconds instead of 10 minutes.

import { expect, test } from "bun:test";

test("no prompt and no stdin exits 1 with the missing-input error (no --print mention)", async () => {
  const p = Bun.spawn(["bun", "run", "src/main.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PTY_TURN_TIMEOUT_MS: "3000" },
  });
  p.stdin.end(); // piped-but-empty stdin: not a tty, EOF immediately

  const errText = await new Response(p.stderr).text();
  const code = await p.exited;

  expect(errText).toContain(
    "Error: Input must be provided either through stdin or as a prompt argument",
  );
  expect(errText).not.toContain("--print");
  expect(code).toBe(1);
}, 20_000);
