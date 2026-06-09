// tests/cli.test.ts
import { expect, test } from "bun:test";
import { helpText, parseArgs } from "../src/cli";

const fixedId = () => "fixed-uuid";

// ─── --help / -h tests ────────────────────────────────────────────────────────

test("help defaults to false when no help flag is present", () => {
  const c = parseArgs(["hello"], fixedId);
  expect(c.help).toBe(false);
});

test("--help sets help to true", () => {
  const c = parseArgs(["--help"], fixedId);
  expect(c.help).toBe(true);
});

test("-h sets help to true", () => {
  const c = parseArgs(["-h"], fixedId);
  expect(c.help).toBe(true);
});

test("--help short-circuits: does not throw even when -p is also present", () => {
  expect(() => parseArgs(["-p", "--help"], fixedId)).not.toThrow();
  expect(parseArgs(["-p", "--help"], fixedId).help).toBe(true);
});

test("--help short-circuits before a positional message is consumed", () => {
  const c = parseArgs(["do something", "--help"], fixedId);
  expect(c.help).toBe(true);
});

test("helpText mentions the tool name and core claude-pty-owned flags", () => {
  const t = helpText();
  expect(t).toContain("claude-pty");
  expect(t).toContain("--output-format");
  expect(t).toContain("--input-format");
  expect(t).toContain("--json-schema");
  expect(t).toContain("--system-prompt");
  expect(t).toContain("--help");
});

test("helpText documents passthrough behavior and env vars and exit codes", () => {
  const t = helpText();
  expect(t.toLowerCase()).toContain("passthrough");
  expect(t).toContain("CLAUDE_PTY_BIN");
  expect(t).toContain("CLAUDE_PTY_TURN_TIMEOUT_MS");
  expect(t.toLowerCase()).toContain("exit");
});

test("extracts message and defaults output-format to text", () => {
  const c = parseArgs(["hello world"], fixedId);
  expect(c.message).toBe("hello world");
  expect(c.outputFormat).toBe("text");
  expect(c.sessionId).toBe("fixed-uuid");
  expect(c.passthrough).toEqual([]);
});

test("consumes --output-format, never forwarding it", () => {
  const c = parseArgs(["--output-format", "json", "hi"], fixedId);
  expect(c.outputFormat).toBe("json");
  expect(c.message).toBe("hi");
  expect(c.passthrough).not.toContain("--output-format");
});

test("--print throws an error (claude-pty replaces -p)", () => {
  expect(() => parseArgs(["--print", "hi"], fixedId)).toThrow(
    "--print/-p flag is not supported",
  );
});

test("-p throws an error (claude-pty replaces -p)", () => {
  expect(() => parseArgs(["-p", "hi"], fixedId)).toThrow(
    "--print/-p flag is not supported",
  );
});

test("forwards unknown flags with their values as passthrough", () => {
  const c = parseArgs(
    ["--model", "opus", "--allowedTools", "Read,Edit", "do it"],
    fixedId,
  );
  expect(c.passthrough).toEqual([
    "--model",
    "opus",
    "--allowedTools",
    "Read,Edit",
  ]);
  expect(c.message).toBe("do it");
});

test("uses a provided --session-id instead of generating one", () => {
  const c = parseArgs(["--session-id", "abc-123", "hi"], fixedId);
  expect(c.sessionId).toBe("abc-123");
  expect(c.passthrough).toContain("--session-id");
  expect(c.passthrough).toContain("abc-123");
});

test("--continue does not consume the message", () => {
  const c = parseArgs(["--continue", "what was the codeword"], () => "id");
  expect(c.message).toBe("what was the codeword");
  expect(c.passthrough).toContain("--continue");
  expect(c.passthrough).not.toContain("what was the codeword");
});
test("-c (continue alias) does not consume the message", () => {
  const c = parseArgs(["-c", "hello"], () => "id");
  expect(c.message).toBe("hello");
  expect(c.passthrough).toEqual(["-c"]);
});
test("--fork-session is boolean (does not eat the message)", () => {
  const c = parseArgs(["--resume", "sid", "--fork-session", "go"], () => "id");
  expect(c.message).toBe("go");
});
test("value-taking flags still consume their value", () => {
  const c = parseArgs(["--model", "opus", "hi"], () => "id");
  expect(c.passthrough).toEqual(["--model", "opus"]);
  expect(c.message).toBe("hi");
});

// ─── --json-schema tests ──────────────────────────────────────────────────────

test("--json-schema is captured into config.jsonSchema and NOT in passthrough", () => {
  const schema =
    '{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}';
  const c = parseArgs(["--json-schema", schema, "set x to hi"], fixedId);
  expect(c.jsonSchema).toBe(schema);
  expect(c.passthrough).not.toContain("--json-schema");
  expect(c.passthrough).not.toContain(schema);
  expect(c.message).toBe("set x to hi");
});

test("--json-schema without user system prompt: passthrough has --system-prompt with schema instruction", () => {
  const schema =
    '{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}';
  const c = parseArgs(["--json-schema", schema, "go"], fixedId);
  const spIdx = c.passthrough.indexOf("--system-prompt");
  expect(spIdx).toBeGreaterThanOrEqual(0);
  const spValue = c.passthrough[spIdx + 1]!;
  expect(spValue).toContain(schema);
  expect(spValue.toLowerCase()).toContain("json");
});

test("--system-prompt without --json-schema: passthrough has --system-prompt unchanged", () => {
  const c = parseArgs(["--system-prompt", "Be brief.", "hi"], fixedId);
  expect(c.systemPrompt).toBe("Be brief.");
  const spIdx = c.passthrough.indexOf("--system-prompt");
  expect(spIdx).toBeGreaterThanOrEqual(0);
  expect(c.passthrough[spIdx + 1]).toBe("Be brief.");
});

test("--system-prompt + --json-schema: passthrough --system-prompt merges both", () => {
  const schema = '{"type":"object"}';
  const c = parseArgs(
    ["--system-prompt", "Be terse.", "--json-schema", schema, "go"],
    fixedId,
  );
  expect(c.systemPrompt).toBe("Be terse.");
  expect(c.jsonSchema).toBe(schema);
  const spIdx = c.passthrough.indexOf("--system-prompt");
  expect(spIdx).toBeGreaterThanOrEqual(0);
  const spValue = c.passthrough[spIdx + 1]!;
  // merged value contains user prompt AND schema instruction
  expect(spValue).toContain("Be terse.");
  expect(spValue).toContain(schema);
  // only ONE --system-prompt in passthrough
  const count = c.passthrough.filter((v) => v === "--system-prompt").length;
  expect(count).toBe(1);
});

test("--append-system-prompt always passes through untouched", () => {
  const c = parseArgs(
    ["--append-system-prompt", "Always end with DONE.", "hi"],
    fixedId,
  );
  expect(c.passthrough).toContain("--append-system-prompt");
  expect(c.passthrough).toContain("Always end with DONE.");
});

test("--append-system-prompt passes through even when --json-schema present", () => {
  const schema = '{"type":"object"}';
  const c = parseArgs(
    ["--append-system-prompt", "extra.", "--json-schema", schema, "go"],
    fixedId,
  );
  expect(c.passthrough).toContain("--append-system-prompt");
  expect(c.passthrough).toContain("extra.");
});

// ─── --input-format tests ─────────────────────────────────────────────────────

test("inputFormat defaults to text", () => {
  const c = parseArgs(["hello"], fixedId);
  expect(c.inputFormat).toBe("text");
});

test("--input-format stream-json sets inputFormat to stream-json", () => {
  const c = parseArgs(["--input-format", "stream-json"], fixedId);
  expect(c.inputFormat).toBe("stream-json");
});

test("--input-format is NOT forwarded to passthrough", () => {
  const c = parseArgs(["--input-format", "stream-json", "hi"], fixedId);
  expect(c.passthrough).not.toContain("--input-format");
  expect(c.passthrough).not.toContain("stream-json");
});

test("--input-format text sets inputFormat to text explicitly", () => {
  const c = parseArgs(["--input-format", "text", "hi"], fixedId);
  expect(c.inputFormat).toBe("text");
});
