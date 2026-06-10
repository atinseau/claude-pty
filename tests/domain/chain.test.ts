// tests/domain/chain.test.ts
//
// Turn-chain filter: when two runs resume the SAME session in parallel, claude
// appends both turns interleaved into one transcript file (verified against the
// real CLI). Real `claude -p` is immune because it never re-reads the file —
// claude-pty tails it, so without filtering each driver collects the OTHER
// run's events too. The filter admits only the chain rooted at OUR injected
// message, followed via uuid/parentUuid over RAW lines (the chain passes
// through `attachment` events that the parser otherwise ignores, and the
// injected user line carries STRING content the parser also ignores).
//
// Fixture mirrors the real interleaved transcript observed from two parallel
// `claude -p --resume <same-id>` runs.

import { expect, test } from "bun:test";
import { makeTurnChainFilter } from "../../src/domain/chain";

const HISTORY_TAIL = "hist-tail";

/** Raw transcript line objects, in the on-disk interleaved order. */
const userC = {
  type: "user",
  uuid: "user-c",
  parentUuid: HISTORY_TAIL,
  message: { role: "user", content: "Reply with exactly: C=<n>" },
};
const attachC = { type: "attachment", uuid: "attach-c", parentUuid: "user-c" };
const userD = {
  type: "user",
  uuid: "user-d",
  parentUuid: HISTORY_TAIL,
  message: { role: "user", content: "Reply with exactly: D=<n>" },
};
const attachD = { type: "attachment", uuid: "attach-d", parentUuid: "user-d" };
const asstC = {
  type: "assistant",
  uuid: "asst-c",
  parentUuid: "attach-c",
  message: { model: "m", content: [{ type: "text", text: "C=42" }] },
};
const asstD = {
  type: "assistant",
  uuid: "asst-d",
  parentUuid: "attach-d",
  message: { model: "m", content: [{ type: "text", text: "D=42" }] },
};
const modeLine = { type: "mode", mode: "default" }; // no uuid: metadata

test("admits only the chain rooted at the seeded message, in interleaved order", () => {
  const f = makeTurnChainFilter();
  f.seed("Reply with exactly: C=<n>");

  const admitted = [userC, attachC, userD, attachD, asstC, asstD].filter((o) =>
    f.admit(o),
  );
  expect(admitted).toEqual([userC, attachC, asstC]);
});

test("the other run's seed admits the other chain", () => {
  const f = makeTurnChainFilter();
  f.seed("Reply with exactly: D=<n>");

  const admitted = [userC, attachC, userD, attachD, asstC, asstD].filter((o) =>
    f.admit(o),
  );
  expect(admitted).toEqual([userD, attachD, asstD]);
});

test("lines without a uuid (metadata) are always admitted — the parser ignores them", () => {
  const f = makeTurnChainFilter();
  expect(f.admit(modeLine)).toBe(true);
  expect(f.admit("not an object")).toBe(true);
  expect(f.admit(null)).toBe(true);
});

test("seed text match is whitespace-tolerant (trimmed)", () => {
  const f = makeTurnChainFilter();
  f.seed("  Reply with exactly: C=<n>\n");
  expect(f.admit(userC)).toBe(true);
});

test("tool_result user events chain through our assistant", () => {
  const f = makeTurnChainFilter();
  f.seed("do something");
  const u = {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    message: { role: "user", content: "do something" },
  };
  const a = {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    message: {
      model: "m",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
    },
  };
  const toolResult = {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  };
  expect([u, a, toolResult].filter((o) => f.admit(o))).toEqual([
    u,
    a,
    toolResult,
  ]);
});

test("an unseeded filter rejects uuid'd events (nothing claimed yet)", () => {
  const f = makeTurnChainFilter();
  expect(f.admit(userC)).toBe(false);
  expect(f.admit(asstC)).toBe(false);
});

test("multi-turn: a second seed claims the next turn's user message", () => {
  const f = makeTurnChainFilter();
  f.seed("turn one");
  const u1 = {
    type: "user",
    uuid: "t1-u",
    parentUuid: "old",
    message: { role: "user", content: "turn one" },
  };
  const a1 = {
    type: "assistant",
    uuid: "t1-a",
    parentUuid: "t1-u",
    message: { model: "m", content: [{ type: "text", text: "one" }] },
  };
  expect(f.admit(u1)).toBe(true);
  expect(f.admit(a1)).toBe(true);

  f.seed("turn two");
  const u2 = {
    type: "user",
    uuid: "t2-u",
    parentUuid: "t1-a",
    message: { role: "user", content: "turn two" },
  };
  expect(f.admit(u2)).toBe(true);
});

test("array-content user prompts can also claim a seed", () => {
  const f = makeTurnChainFilter();
  f.seed("hello there");
  const u = {
    type: "user",
    uuid: "u1",
    parentUuid: "old",
    message: {
      role: "user",
      content: [{ type: "text", text: "hello there" }],
    },
  };
  expect(f.admit(u)).toBe(true);
});

test("identical parallel prompts: first arrival claims the seed (documented limitation)", () => {
  const f = makeTurnChainFilter();
  f.seed("same text");
  const theirs = {
    type: "user",
    uuid: "their-u",
    parentUuid: "old",
    message: { role: "user", content: "same text" },
  };
  const ours = {
    type: "user",
    uuid: "our-u",
    parentUuid: "old",
    message: { role: "user", content: "same text" },
  };
  expect(f.admit(theirs)).toBe(true); // claims the seed — indistinguishable
  expect(f.admit(ours)).toBe(false); // no seed left
});
