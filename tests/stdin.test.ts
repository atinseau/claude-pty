// tests/stdin.test.ts
import { expect, test } from "bun:test";
import { combineMessage } from "../src/stdin";

test("positional only", () => {
  expect(combineMessage("hi", "")).toBe("hi");
});
test("stdin only", () => {
  expect(combineMessage("", "piped text")).toBe("piped text");
});
test("positional + stdin joined (mirrors -p context append)", () => {
  expect(combineMessage("explain", "error log line")).toBe(
    "explain\n\nerror log line",
  );
});
test("trims surrounding whitespace on each part", () => {
  expect(combineMessage("  hi  ", "\nlog\n")).toBe("hi\n\nlog");
});
