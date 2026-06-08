// src/stdin.ts
import { isatty } from "tty";

export function combineMessage(positional: string, stdinText: string): string {
  return [positional.trim(), stdinText.trim()].filter(Boolean).join("\n\n");
}

/**
 * Read piped stdin if present (not a TTY). Returns "" when stdin is a terminal.
 *
 * Uses tty.isatty(0) rather than process.stdin.isTTY: under Bun on Windows the
 * latter is `undefined` even for a real terminal, so the guard would never fire
 * and an interactive run (no pipe) would block forever waiting for EOF.
 */
export async function readStdin(): Promise<string> {
  if (isatty(0)) return "";
  return await new Response(Bun.stdin.stream()).text();
}
