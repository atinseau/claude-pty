// src/structured.ts
/**
 * Extract the validated structured output (`--json-schema`) from the raw transcript.
 * Claude Code persists it as a line of type "attachment" with
 * attachment.type === "structured_output" and the validated object at attachment.data.
 *
 * Confirmed shape (live run 2026-06-08, session 38404788-2af8-4a9f-9ed9-7703eb54e84c):
 *   {"type":"attachment","attachment":{"type":"structured_output","data":{"x":"hi"}},...}
 *
 * (See also: docs/superpowers/findings/spike-C-continue.md §3.)
 *
 * Returns undefined when no structured-output attachment is present.
 */
export function extractStructuredOutput(rawTranscript: string): unknown | undefined {
  // Scan lines bottom-up so the last attachment wins if multiple are present.
  const lines = rawTranscript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "attachment" && o?.attachment?.type === "structured_output") {
      return o.attachment.data;
    }
  }
  return undefined;
}
