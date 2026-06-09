// tests/format-text.test.ts
import { expect, test } from "bun:test";
import { formatText } from "../src/format/text";
import { parseTranscript } from "../src/transcript";

test("text format prints only the final assistant text", async () => {
  const events = parseTranscript(
    await Bun.file("tests/fixtures/session.jsonl").text(),
  );
  expect(formatText(events)).toBe("The file says: hello from foo");
});
