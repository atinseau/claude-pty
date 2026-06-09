// src/ndjson.ts
/**
 * Parse newline-delimited JSON user messages (claude -p --input-format stream-json).
 * Accepts lines like {"type":"user","content":"hi"} or
 * {"type":"user","message":{"role":"user","content":"hi"}} or content as an array
 * of {type:"text",text:"..."} blocks. Returns the plain-text message for each user line.
 * Non-user / unparseable lines are skipped.
 */
export function parseNdjsonMessages(text: string): string[] {
  const results: string[] = [];
  for (const rawLine of text.split("\n")) {
    // Strip carriage returns for Windows CRLF compatibility
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const obj = o as Record<string, unknown>;
    if (obj["type"] !== "user") continue;

    // Resolve content: prefer top-level content, fall back to message.content
    let content: unknown = obj["content"];
    if (content === undefined) {
      const msg = obj["message"];
      if (msg && typeof msg === "object") {
        content = (msg as Record<string, unknown>)["content"];
      }
    }

    if (content === undefined) continue;

    if (typeof content === "string") {
      results.push(content);
    } else if (Array.isArray(content)) {
      // Concatenate text blocks
      const text = (content as unknown[])
        .filter(
          (b): b is { type: string; text: string } =>
            !!b &&
            typeof b === "object" &&
            (b as Record<string, unknown>)["type"] === "text",
        )
        .map((b) => b.text)
        .join("");
      results.push(text);
    }
    // Other content types (object, number, etc.) are skipped
  }
  return results;
}
