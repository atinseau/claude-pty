// tests/golden.test.ts
import { test, expect } from "bun:test";

const RUN = process.env.CLAUDE_PTY_E2E === "1";

test.skipIf(!RUN)("claude-pty text output matches claude -p text output", async () => {
  const prompt = "Reply with exactly the word: pong";

  const ref = await new Response(
    Bun.spawn(["claude", "-p", "--output-format", "text", prompt]).stdout
  ).text();

  const ours = await new Response(
    Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "text", prompt]).stdout
  ).text();

  expect(ours.trim()).toBe(ref.trim());
}, 60_000);

test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("stream-json event types match claude -p shape", async () => {
  const prompt = "Reply with exactly the word: pong";
  const raw = await new Response(Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "stream-json", prompt]).stdout).text();
  const types = raw.trim().split("\n").map((l) => JSON.parse(l).type);
  expect(types[0]).toBe("system");
  expect(types[types.length - 1]).toBe("result");
  expect(types).toContain("assistant");
}, 60000);

test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("bad API key yields non-zero exit + is_error", async () => {
  // Use a short turn timeout so the process exits promptly when auth fails.
  // The TUI may show an interactive "use this API key?" dialog; after the
  // turn timeout expires, main.ts detects the error from the transcript/pty
  // and exits non-zero.
  const p = Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "json", "hi"], {
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-bad-key", CLAUDE_PTY_TURN_TIMEOUT_MS: "20000" },
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  expect(code).not.toBe(0);
  // if a json result was produced, it must carry is_error
  if (out.trim()) expect(JSON.parse(out.trim().split("\n").pop()!).is_error).toBe(true);
}, 60000);
