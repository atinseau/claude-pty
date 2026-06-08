// tests/cli.test.ts
import { test, expect } from "bun:test";
import { parseArgs } from "../src/cli";

const fixedId = () => "fixed-uuid";

test("extracts message and defaults output-format to text", () => {
  const c = parseArgs(["hello world"], fixedId);
  expect(c.message).toBe("hello world");
  expect(c.outputFormat).toBe("text");
  expect(c.sessionId).toBe("fixed-uuid");
  expect(c.passthrough).toEqual([]);
});

test("consumes -p and --output-format, never forwarding them", () => {
  const c = parseArgs(["-p", "--output-format", "json", "hi"], fixedId);
  expect(c.outputFormat).toBe("json");
  expect(c.message).toBe("hi");
  expect(c.passthrough).not.toContain("-p");
  expect(c.passthrough).not.toContain("--output-format");
});

test("forwards unknown flags with their values as passthrough", () => {
  const c = parseArgs(["--model", "opus", "--allowedTools", "Read,Edit", "do it"], fixedId);
  expect(c.passthrough).toEqual(["--model", "opus", "--allowedTools", "Read,Edit"]);
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
  const c = parseArgs(["--resume","sid","--fork-session","go"], () => "id");
  expect(c.message).toBe("go");
});
test("value-taking flags still consume their value", () => {
  const c = parseArgs(["--model","opus","hi"], () => "id");
  expect(c.passthrough).toEqual(["--model","opus"]);
  expect(c.message).toBe("hi");
});

test("--json-schema is forwarded to passthrough with its value", () => {
  const schema = '{"type":"object"}';
  const c = parseArgs(["--json-schema", schema, "set x to hi"], () => "id");
  expect(c.passthrough).toContain("--json-schema");
  expect(c.passthrough).toContain(schema);
  expect(c.message).toBe("set x to hi");
});
