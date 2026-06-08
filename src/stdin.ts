// src/stdin.ts
export function combineMessage(positional: string, stdinText: string): string {
  return [positional.trim(), stdinText.trim()].filter(Boolean).join("\n\n");
}

/** Read piped stdin if present (not a TTY). Returns "" when stdin is a terminal. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Response(Bun.stdin.stream()).text();
}
