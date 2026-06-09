// tests/node-pty-agent.test.ts
import { describe, expect, test } from "bun:test";
import { isNodePtyAgentInvocation } from "../src/node-pty-agent";

describe("isNodePtyAgentInvocation", () => {
  test("true when argv contains node-pty's conpty console-list agent path", () => {
    expect(
      isNodePtyAgentInvocation([
        "C:/app/claude-pty.exe",
        "C:/app/node_modules/node-pty/lib/conpty_console_list_agent",
        "40348",
      ]),
    ).toBe(true);
  });

  test("false for a normal user invocation", () => {
    expect(
      isNodePtyAgentInvocation([
        "C:/app/claude-pty.exe",
        "--output-format",
        "json",
        "say only: ok",
      ]),
    ).toBe(false);
  });

  test("false for empty argv", () => {
    expect(isNodePtyAgentInvocation([])).toBe(false);
  });
});
