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

test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("permission box is auto-denied; run terminates without hanging", async () => {
  const p = Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "text", "--permission-mode", "default", "Run the shell command: git status"], { env: { ...process.env, CLAUDE_PTY_TURN_TIMEOUT_MS: "60000" } });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  expect(out.length).toBeGreaterThan(0); // produced a response, i.e. did not hang to timeout
}, 90000);

test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("--continue/--resume recalls prior conversation", async () => {
  // Turn 1: plant a codeword, capture session id via JSON output.
  const spawnEnv = { env: { ...process.env, CLAUDE_PTY_TURN_TIMEOUT_MS: "60000" } };
  const rawJson = await new Response(
    Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "json", "Remember the codeword: platypus"], spawnEnv).stdout
  ).text();
  const sessionId = JSON.parse(rawJson.trim()).session_id as string;
  expect(sessionId).toBeTruthy();

  // Turn 2: --resume <id> so we target exactly the session we just created,
  // bypassing the "most-recent-session" ambiguity that --continue has when
  // an ambient agent session is also open in the same project directory.
  const out = await new Response(
    Bun.spawn(["bun", "run", "src/main.ts", "--output-format", "text", "--resume", sessionId, "What was the codeword? One word."], spawnEnv).stdout
  ).text();
  expect(out.toLowerCase()).toContain("platypus");
}, 150000);

// Non-e2e: --print must exit non-zero (claude-pty replaces -p; passing --print is an error)
test("--print flag causes non-zero exit", async () => {
  const p = Bun.spawn(["bun", "run", "src/main.ts", "--print", "hi"], {
    env: { ...process.env },
  });
  const code = await p.exited;
  expect(code).not.toBe(0);
});

test("-p flag causes non-zero exit", async () => {
  const p = Bun.spawn(["bun", "run", "src/main.ts", "-p", "hi"], {
    env: { ...process.env },
  });
  const code = await p.exited;
  expect(code).not.toBe(0);
});

test.skipIf(process.env.CLAUDE_PTY_E2E !== "1")("--json-schema yields structured_output via TUI (no -p)", async () => {
  const schema = '{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}';
  const out = await new Response(
    Bun.spawn(
      ["bun", "run", "src/main.ts", "--output-format", "json", "--json-schema", schema, "Set x to the string hi."],
      { env: { ...process.env, CLAUDE_PTY_TURN_TIMEOUT_MS: "60000" } }
    ).stdout
  ).text();
  const result = JSON.parse(out.trim().split("\n").pop()!);
  expect(result.structured_output).toEqual({ x: "hi" });
}, 90000);
