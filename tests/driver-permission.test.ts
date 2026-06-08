// tests/driver-permission.test.ts
//
// Unit tests for isPermissionPrompt() — the pure predicate that detects
// Claude Code's interactive tool-approval dialog.
//
// Phrases verified in docs/superpowers/findings/spike-B-permission.md
// against a live calibration run (session 0a722727, Claude Code 2.1.168).

import { test, expect } from "bun:test";
import { isPermissionPrompt } from "../src/driver";

test("detects the permission box (verbatim Spike B phrases)", () => {
  const box =
    "Bash command\n  rtk git status\nThis command requires approval\n\nDo you want to proceed?\n❯ 1. Yes\n  3. No";
  expect(isPermissionPrompt(box)).toBe(true);
});

test("does not fire on normal assistant output", () => {
  expect(isPermissionPrompt("Here is the answer: 42")).toBe(false);
});

test("fires on 'This command requires approval' alone", () => {
  expect(isPermissionPrompt("...some preamble...This command requires approval...")).toBe(true);
});

test("fires on 'Do you want to proceed?' alone", () => {
  expect(isPermissionPrompt("Do you want to proceed?")).toBe(true);
});

test("does not fire on empty string", () => {
  expect(isPermissionPrompt("")).toBe(false);
});

test("does not fire on spinner ANSI chunks", () => {
  expect(isPermissionPrompt("]0;⠂ Claude Code")).toBe(false);
});
