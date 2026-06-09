// tests/format-text.test.ts
import { expect, test } from "bun:test";
import { parseTranscript } from "../../src/domain/transcript";
import { formatText } from "../../src/output/text";

test("text format prints only the final assistant text", async () => {
  const events = parseTranscript(
    await Bun.file("tests/fixtures/session.jsonl").text(),
  );
  expect(formatText(events)).toBe("The file says: hello from foo");
});
