// tests/pricing.test.ts
import { expect, test } from "bun:test";
import { costOf, modelMeta } from "../../src/domain/pricing";

// Prices calibrated against real `claude -p --output-format json` cost output.
test("opus-4-8 input+output = $5 + $25 per million tokens", () => {
  const cost = costOf("claude-opus-4-8", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  expect(cost).toBeCloseTo(30, 5);
});

test("opus-4-8 cost matches a real claude -p calibration sample", () => {
  // claude -p reported total_cost_usd 0.060057 for this exact usage.
  const cost = costOf("claude-opus-4-8", {
    input_tokens: 6042,
    output_tokens: 4,
    cache_creation_input_tokens: 3086,
    cache_read_input_tokens: 20919,
  });
  expect(cost).toBeCloseTo(0.060057, 4);
});

test("sonnet-4-6 cost matches a real claude -p calibration sample", () => {
  // claude -p: 0.04191165 for in=3/out=5/cc=9483/cr=20888.
  const cost = costOf("claude-sonnet-4-6", {
    input_tokens: 3,
    output_tokens: 5,
    cache_creation_input_tokens: 9483,
    cache_read_input_tokens: 20888,
  });
  expect(cost).toBeCloseTo(0.04191165, 5);
});

test("haiku-4-5 cost matches a real claude -p calibration sample", () => {
  // claude -p: 0.0151561 for in=10/out=185/cc=9654/cr=21536.
  const cost = costOf("claude-haiku-4-5", {
    input_tokens: 10,
    output_tokens: 185,
    cache_creation_input_tokens: 9654,
    cache_read_input_tokens: 21536,
  });
  expect(cost).toBeCloseTo(0.0151561, 5);
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

test("modelMeta returns verified context/output sizes for known models", () => {
  expect(modelMeta("claude-opus-4-8[1m]")).toEqual({
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  });
  expect(modelMeta("claude-opus-4-8")).toEqual({
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  });
  expect(modelMeta("claude-sonnet-4-6")).toEqual({
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  });
  expect(modelMeta("claude-haiku-4-5")).toEqual({
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  });
  expect(modelMeta("made-up-model")).toBeUndefined();
});
