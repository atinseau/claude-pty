// tests/signature.test.ts
import { describe, expect, test } from "bun:test";
import { signatureOf } from "../src/signature";

const base = {
  cwd: "C:/proj",
  bin: "C:/claude.exe",
  passthrough: ["--model", "opus"],
  env: { PATH: "/x", ANTHROPIC_API_KEY: "k1" },
};

describe("signatureOf", () => {
  test("identical inputs → identical signature", () => {
    expect(signatureOf(base)).toBe(signatureOf({ ...base }));
  });

  test("differs on cwd", () => {
    expect(signatureOf(base)).not.toBe(
      signatureOf({ ...base, cwd: "C:/other" }),
    );
  });

  test("differs on claude-affecting flags", () => {
    expect(signatureOf(base)).not.toBe(
      signatureOf({ ...base, passthrough: ["--model", "sonnet"] }),
    );
  });

  test("differs on relevant env (e.g. API key)", () => {
    expect(signatureOf(base)).not.toBe(
      signatureOf({ ...base, env: { PATH: "/x", ANTHROPIC_API_KEY: "k2" } }),
    );
  });

  test("ignores --session-id (the pool assigns it)", () => {
    expect(
      signatureOf({
        ...base,
        passthrough: ["--session-id", "abc", "--model", "opus"],
      }),
    ).toBe(signatureOf(base));
  });

  test("ignores CLAUDECODE / CLAUDE_CODE_* (stripped from the TUI env)", () => {
    expect(
      signatureOf({
        ...base,
        env: {
          PATH: "/x",
          ANTHROPIC_API_KEY: "k1",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "s",
        },
      }),
    ).toBe(signatureOf(base));
  });

  test("env key order does not matter", () => {
    expect(
      signatureOf({
        ...base,
        env: { ANTHROPIC_API_KEY: "k1", PATH: "/x" },
      }),
    ).toBe(signatureOf(base));
  });
});
