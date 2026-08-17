// tests/platform.test.ts
import { expect, test } from "bun:test";
import { binaryName } from "../src/platform";

test("the Windows binary carries the .exe suffix", () => {
  expect(binaryName("win32")).toBe("claude-pty.exe");
});

test("unix binaries carry no suffix", () => {
  expect(binaryName("darwin")).toBe("claude-pty");
  expect(binaryName("linux")).toBe("claude-pty");
});

test("defaults to the host platform", () => {
  expect(binaryName()).toBe(binaryName(process.platform));
});
