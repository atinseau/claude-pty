// tests/format-text.test.ts
import { test, expect } from "bun:test";
import { parseTranscript } from "../src/transcript";
import { formatText } from "../src/format/text";

test("text format prints only the final assistant text", async () => {
  const events = parseTranscript(await Bun.file("tests/fixtures/session.jsonl").text());
  expect(formatText(events)).toBe("The file says: hello from foo");
});
