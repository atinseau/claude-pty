// tests/driver-env.test.ts
import { describe, expect, test } from "bun:test";
import { childEnv } from "../src/driver";

describe("childEnv", () => {
  test("strips CLAUDECODE and all CLAUDE_CODE_* nesting signals", () => {
    const out = childEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_EXECPATH: "C:/claude.exe",
      PATH: "/usr/bin",
    });
    expect(out.CLAUDECODE).toBeUndefined();
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(out.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(out.CLAUDE_CODE_EXECPATH).toBeUndefined();
    // Unrelated vars are preserved untouched.
    expect(out.PATH).toBe("/usr/bin");
  });

  test("preserves claude-pty's own CLAUDE_PTY_* configuration vars", () => {
    const out = childEnv({
      CLAUDE_PTY_BIN: "C:/claude.exe",
      CLAUDE_PTY_TURN_TIMEOUT_MS: "5000",
    });
    expect(out.CLAUDE_PTY_BIN).toBe("C:/claude.exe");
    expect(out.CLAUDE_PTY_TURN_TIMEOUT_MS).toBe("5000");
  });

  test("does not mutate the input env object", () => {
    const input = { CLAUDECODE: "1", PATH: "/x" };
    childEnv(input);
    expect(input.CLAUDECODE).toBe("1");
  });
});
