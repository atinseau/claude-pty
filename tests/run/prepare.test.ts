// tests/run/prepare.test.ts
//
// prepare() routing: --resume / --continue must hand their message to drive() as
// an injected turn (ndjsonMessages) with config.message cleared, so the session
// spawns multi-turn (no auto-inject) and drive() can settle the resumed TUI's
// history replay before submitting. A normal session keeps auto-inject.

import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { parseArgs } from "../../src/cli/args";
import { prepare } from "../../src/run/prepare";

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

test("--resume folds piped stdin into the single injected turn", async () => {
  const argv = ["--resume", "res-id", "question"];
  const config = parseArgs(argv);
  const p = await prepare(config, argv, "extra context", tmpdir());

  expect(config.message).toBe("");
  expect(p.ndjsonMessages).toEqual(["question\n\nextra context"]);
});
