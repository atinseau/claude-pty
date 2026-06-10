// tests/run/prepare.test.ts
//
// prepare() routing: --resume / --continue must hand their message to drive() as
// an injected turn (ndjsonMessages) with config.message cleared, so the session
// spawns multi-turn (no auto-inject) and drive() can settle the resumed TUI's
// history replay before submitting. A normal session keeps auto-inject.

import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { parseArgs } from "../../src/cli/args";
import {
  MISSING_INPUT_ERROR,
  missingInput,
  prepare,
} from "../../src/run/prepare";

test("new session keeps the message for auto-inject (no ndjson turns)", async () => {
  const argv = ["hello there"];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "", tmpdir());

  expect(config.message).toBe("hello there");
  expect(p.ndjsonMessages).toEqual([]);
  expect(p.sess.mode).toBe("new");
});

test("--resume routes the message to an injected turn and clears config.message", async () => {
  const argv = ["--resume", "res-id", "recall the number"];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "", tmpdir());

  expect(config.message).toBe(""); // spawns multi-turn (driver won't auto-inject)
  expect(p.ndjsonMessages).toEqual(["recall the number"]);
  expect(p.sess.mode).toBe("resume");
});

test("--continue routes the message to an injected turn and clears config.message", async () => {
  const argv = ["--continue", "keep going"];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "", tmpdir());

  expect(config.message).toBe("");
  expect(p.ndjsonMessages).toEqual(["keep going"]);
  expect(p.sess.mode).toBe("continue");
});

// missingInput(): claude -p parity — print mode with no prompt argument and no
// piped stdin must fail fast instead of spawning a TUI that idles to the turn
// timeout (real claude -p: "Error: Input must be provided either through stdin
// or as a prompt argument when using --print", exit 1).

test("no message and no stdin is missing input", async () => {
  const argv: string[] = [];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "", tmpdir());

  expect(missingInput(config, p.sess)).toBe(true);
});

test("a positional message is not missing input", async () => {
  const argv = ["hello"];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "", tmpdir());

  expect(missingInput(config, p.sess)).toBe(false);
});

test("piped stdin alone is not missing input", async () => {
  const argv: string[] = [];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "from stdin", tmpdir());

  expect(missingInput(config, p.sess)).toBe(false);
});

test("stream-json input with empty stdin is not missing input (claude -p exits 0 there)", async () => {
  const argv = ["--input-format", "stream-json"];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "", tmpdir());

  expect(missingInput(config, p.sess)).toBe(false);
});

test("--resume / --continue without a message are not missing input", async () => {
  for (const argv of [["--resume", "res-id"], ["--continue"]]) {
    const config = parseArgs(argv);
    const p = await prepare(config, argv, "", tmpdir());

    expect(missingInput(config, p.sess)).toBe(false);
  }
});

test("MISSING_INPUT_ERROR follows claude -p's wording WITHOUT mentioning the banned --print flag", () => {
  expect(MISSING_INPUT_ERROR).toBe(
    "Error: Input must be provided either through stdin or as a prompt argument",
  );
  // claude-pty rejects --print/-p outright, so the error must never point users to it.
  expect(MISSING_INPUT_ERROR).not.toContain("--print");
});

test("--resume folds piped stdin into the single injected turn", async () => {
  const argv = ["--resume", "res-id", "question"];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "extra context", tmpdir());

  expect(config.message).toBe("");
  expect(p.ndjsonMessages).toEqual(["question\n\nextra context"]);
});
