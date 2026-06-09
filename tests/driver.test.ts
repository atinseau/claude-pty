// tests/driver.test.ts
//
// Unit tests for the driver's pure-logic isReady() predicate.
//
// Sample strings were captured from a real calibration run against
// Claude Code 2.1.168 (session cc29e93c-3ac2-4bd3-905b-e86afcd493d1).
//
// KEY FINDING from char-code inspection of the live pty buffer:
//   buffer[1973] = 0x276f  (❯  — HEAVY RIGHT-POINTING ANGLE QUOTATION MARK)
//   buffer[1974] = 0x00a0  (NON-BREAKING SPACE — NOT a regular ASCII space)
//
// All test strings below use "❯ " (or the Unicode literal "❯ ")
// for the prompt signal to avoid encoding ambiguity in the source file.
// Using "❯ " (with a visually identical ASCII space) would make these tests
// silently wrong if the editor normalises the character.

import { expect, test } from "bun:test";
import { isReady } from "../src/driver";

// Prompt signal: ❯ (U+276F) + U+00A0 (non-breaking space)
const PROMPT = "❯ ";

// ─── "Ready" samples (isReady should return true) ────────────────────────────

test("isReady: startup frame contains prompt signal and returns true", () => {
  // Modelled on calibration chunk #9 (initial TUI render, row 38 prompt area).
  // The full chunk is ~2 KB of ANSI escapes; the relevant substring is ❯ .
  const startupChunk =
    "[38;2;136;136;136m\r\n" +
    "────────────────────────────────────────────────────────────────\r\n" +
    "[m" +
    PROMPT +
    '[2mTry "how does <filepath> work?"' +
    "[38;2;136;136;136m[22m\r\n" +
    "────────────────────────────────────────────────────────────────";
  expect(isReady(startupChunk)).toBe(true);
});

test("isReady: post-turn frame with prompt signal at row 38 col 1 returns true", () => {
  // Modelled on calibration chunk #67 (after assistant replied 'pong').
  // ESC[38;1H positions cursor to row 38 col 1; then ❯  is printed.
  const postTurnChunk =
    "[?25l[38;2;153;153;153m[20;1H✳[1CCrunched for 1s" +
    "[m[35;1H[K[38;1H" +
    PROMPT +
    "[38;2;153;153;153m[40;51H← for agents[K[38;3H[?25h";
  expect(isReady(postTurnChunk)).toBe(true);
});

test("isReady: prompt signal anywhere in buffer returns true", () => {
  expect(isReady("some junk " + PROMPT + "more junk")).toBe(true);
});

test("isReady: buffer equals exactly the prompt signal returns true", () => {
  expect(isReady(PROMPT)).toBe(true);
});

// ─── "Not ready" samples (isReady should return false) ───────────────────────

test("isReady: spinner-only chunk during processing returns false", () => {
  // From calibration chunk #16 (title bar update while thinking).
  // Contains braille spinner chars but NOT the prompt signal.
  const spinnerChunk = "]0;⠂ Claude Code";
  expect(isReady(spinnerChunk)).toBe(false);
});

test("isReady: ANSI screen-clear chunk at startup returns false", () => {
  // From calibration chunk #6 (screen clear lines, no prompt yet).
  const clearChunk = "[K\r\n[K\r\n[K\r\n[K\r\n" + "[K\r\n[K\r\n[K\r\n[K[120C";
  expect(isReady(clearChunk)).toBe(false);
});

test("isReady: empty buffer returns false", () => {
  expect(isReady("")).toBe(false);
});

test("isReady: prompt char without trailing NBSP is not a match", () => {
  // ❯ followed by regular ASCII space (0x20) should NOT match —
  // the real signal requires U+00A0 after ❯, not U+0020.
  expect(isReady("]0;❯Claude Code")).toBe(false);
  expect(isReady("❯ ")).toBe(false); // ASCII space — not a match
});

test("isReady: partial escape sequence without prompt signal returns false", () => {
  const chunk = "[?2026h[?2026l[?25l[?25h";
  expect(isReady(chunk)).toBe(false);
});
