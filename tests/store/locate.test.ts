// tests/session.test.ts
import { expect, test } from "bun:test";
import {
  pickMostRecent,
  projectDirName,
  resolveSessionId,
} from "../../src/store/locate";

test("projectDirName mirrors Claude Code's cwd transform", () => {
  expect(projectDirName("C:\\Users\\arthur\\Documents\\Devs\\claude-pty")).toBe(
    "C--Users-arthur-Documents-Devs-claude-pty",
  );
});
test("generated id is used and flagged for injection when none supplied", () => {
  const r = resolveSessionId(["hi"], () => "gen-id");
  expect(r.sessionId).toBe("gen-id");
  expect(r.injectSessionId).toBe(true);
  expect(r.mode).toBe("new");
});
test("explicit --session-id is used and not re-injected", () => {
  const r = resolveSessionId(["--session-id", "abc", "hi"], () => "gen-id");
  expect(r.sessionId).toBe("abc");
  expect(r.injectSessionId).toBe(false);
  expect(r.mode).toBe("explicit");
});
test("--resume <id> tails that id, no generated injection", () => {
  const r = resolveSessionId(["--resume", "res-id", "hi"], () => "gen-id");
  expect(r.sessionId).toBe("res-id");
  expect(r.injectSessionId).toBe(false);
  expect(r.mode).toBe("resume");
});
test("--continue marks discovery mode with unknown id", () => {
  const r = resolveSessionId(["--continue", "hi"], () => "gen-id");
  expect(r.sessionId).toBe(null);
  expect(r.injectSessionId).toBe(false);
  expect(r.mode).toBe("continue");
});

test("pickMostRecent returns the path with the greatest mtime", () => {
  expect(
    pickMostRecent([
      { path: "a.jsonl", mtimeMs: 100 },
      { path: "b.jsonl", mtimeMs: 300 },
      { path: "c.jsonl", mtimeMs: 200 },
    ]),
  ).toBe("b.jsonl");
});
test("pickMostRecent returns null for an empty list", () => {
  expect(pickMostRecent([])).toBe(null);
});
test("pickMostRecent keeps the first entry on an mtime tie (stable)", () => {
  expect(
    pickMostRecent([
      { path: "first.jsonl", mtimeMs: 500 },
      { path: "second.jsonl", mtimeMs: 500 },
    ]),
  ).toBe("first.jsonl");
});
