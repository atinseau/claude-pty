// tests/pricing.test.ts
import { expect, test } from "bun:test";
import { costOf } from "../../src/domain/pricing";

test("opus cost = input + output + cache, per million tokens", () => {
  const cost = costOf("claude-opus-4-8", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  expect(cost).toBeCloseTo(90, 5);
});

test("unknown model falls back to zero cost without throwing", () => {
  expect(
    costOf("made-up-model", {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }),
  ).toBe(0);
});
