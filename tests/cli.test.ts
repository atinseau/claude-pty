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
