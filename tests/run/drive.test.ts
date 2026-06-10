// tests/run/drive.test.ts
//
// drive() in continuation mode (--resume) over a transcript file that another
// parallel run is ALSO appending to. claude allows this (no lock, interleaved
// turns — verified against the real CLI); the driver must reconstruct its
// result from ITS OWN turn chain only. Without the chain filter the other
// run's terminal assistant leaks into `collected`: usage and num_turns sum
// both turns.
//
// The fixture transcript lives under the real ~/.claude/projects root because
// drive() locates --resume transcripts via findTranscriptById's glob over that
// root; a uuid session id keeps it collision-free and it is removed after.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { Config } from "../../src/cli/args";
import type { Session } from "../../src/pty/session";
import { drive } from "../../src/run/drive";

const PROJECT_DIR = join(
  homedir(),
  ".claude",
  "projects",
  "cp-drive-chain-test",
);
afterAll(() => rmSync(PROJECT_DIR, { recursive: true, force: true }));

function userLine(uuid: string, parent: string | null, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid: parent,
    timestamp: "2026-06-10T10:00:00.000Z",
    message: { role: "user", content: text },
  });
}

function attachmentLine(uuid: string, parent: string): string {
  return JSON.stringify({
    type: "attachment",
    uuid,
    parentUuid: parent,
    attachment: {},
  });
}

function assistantLine(
  uuid: string,
  parent: string,
  requestId: string,
  text: string,
  outputTokens: number,
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: parent,
    requestId,
    timestamp: "2026-06-10T10:00:01.000Z",
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

test("resume ignores a parallel run's interleaved turn in the shared transcript", async () => {
  const id = crypto.randomUUID();
  mkdirSync(PROJECT_DIR, { recursive: true });
  const path = join(PROJECT_DIR, `${id}.jsonl`);
  // Prior conversation already on disk (what the resumed TUI replays).
  writeFileSync(
    path,
    `${userLine("hist-u", null, "old question")}\n` +
      `${assistantLine("hist-tail", "hist-u", "r0", "old answer", 3)}\n`,
  );

  let promptBack = false;
  const session: Session = {
    pty: {} as Session["pty"], // drive() never touches the raw pty
    snapshot: () => "",
    ready: Promise.resolve(),
    inject: (msg: string) => {
      // The OTHER run's complete turn lands first, then ours — both forked
      // from the same history tail, exactly as observed with the real CLI.
      appendFileSync(
        path,
        `${userLine("their-u", "hist-tail", "Reply with exactly: THEIRS")}\n` +
          `${attachmentLine("their-att", "their-u")}\n` +
          `${assistantLine("their-a", "their-att", "r-theirs", "THEIRS", 5)}\n` +
          `${userLine("our-u", "hist-tail", msg)}\n` +
          `${attachmentLine("our-att", "our-u")}\n` +
          `${assistantLine("our-a", "our-att", "r-ours", "OURS", 7)}\n`,
      );
      promptBack = true;
    },
    promptBack: () => promptBack,
    msSinceData: () => 100_000, // always "quiet": settle windows pass instantly
    kill: () => {},
    alive: () => true,
  };

  const config: Config = {
    message: "",
    sessionId: id,
    outputFormat: "json",
    inputFormat: "text",
    verbose: false,
    passthrough: [],
    help: false,
  };

  let out = "";
  const code = await drive(
    config,
    session,
    {
      sess: { sessionId: id, injectSessionId: false, mode: "resume" },
      preExisting: null,
      ndjsonMessages: ["our prompt"],
      ptyDone: () => false,
      cwd: tmpdir(),
      turnTimeoutMs: 15_000,
    },
    { out: (s) => (out += s), err: () => {} },
  );

  expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result.result).toBe("OURS");
  expect(result.num_turns).toBe(1); // theirs must NOT count as a second turn
  expect(result.usage.output_tokens).toBe(7); // ours only, not 7 + 5
}, 20_000);
