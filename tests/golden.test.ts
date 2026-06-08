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
