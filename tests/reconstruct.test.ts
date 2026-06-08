// tests/reconstruct.test.ts
import { test, expect } from "bun:test";
import { parseTranscript } from "../src/transcript";
import { reconstruct } from "../src/reconstruct";

test("reconstruct builds the -p result object from the fixture", async () => {
  const events = parseTranscript(await Bun.file("tests/fixtures/session.jsonl").text());
  const costFn = (_m: string, u: any) =>
    (u.input_tokens + u.output_tokens) / 1000;
  const r = reconstruct(events, costFn, "11111111-1111-1111-1111-111111111111");

  expect(r.type).toBe("result");
  expect(r.subtype).toBe("success");
  expect(r.result).toBe("The file says: hello from foo");
  expect(r.session_id).toBe("11111111-1111-1111-1111-111111111111");
  expect(r.num_turns).toBe(2);
  expect(r.usage.input_tokens).toBe(250);
  expect(r.usage.output_tokens).toBe(30);
  expect(r.duration_ms).toBe(3000);
  expect(r.total_cost_usd).toBeCloseTo(0.28, 5);
  expect(r.is_error).toBe(false);
});
