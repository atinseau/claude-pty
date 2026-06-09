// src/pricing.ts
import type { Usage } from "./types";

interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// USD per million tokens. Calibrated against real `claude -p` cost output (the
// reported total_cost_usd matches these rates to 4+ significant figures across
// opus/sonnet/haiku calibration samples — see tests/domain/pricing.test.ts).
const TABLE: Record<string, Price> = {
  "claude-opus-4-8": {
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function priceFor(model: string): Price | undefined {
  if (TABLE[model]) return TABLE[model];
  for (const key of Object.keys(TABLE)) {
    const fam = key.split("-")[1];
    if (fam && model.includes(fam)) return TABLE[key];
  }
  return undefined;
}

/**
 * Static per-model metadata for `modelUsage` (contextWindow / maxOutputTokens).
 * Only models whose values we have VERIFIED against real `claude -p` output are
 * listed; for anything else we return undefined and omit the two fields rather
 * than fabricate them. Keyed by the exact model string the transcript records.
 */
const MODEL_META: Record<
  string,
  { contextWindow: number; maxOutputTokens: number }
> = {
  // Verified against `claude -p --model <m> --output-format json` (modelUsage).
  "claude-opus-4-8[1m]": { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  "claude-opus-4-8": { contextWindow: 200_000, maxOutputTokens: 64_000 },
  "claude-sonnet-4-6": { contextWindow: 200_000, maxOutputTokens: 32_000 },
  "claude-haiku-4-5": { contextWindow: 200_000, maxOutputTokens: 32_000 },
};

export function modelMeta(
  model: string,
): { contextWindow: number; maxOutputTokens: number } | undefined {
  return MODEL_META[model];
}

export function costOf(model: string, u: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (u.input_tokens / 1e6) * p.input +
    (u.output_tokens / 1e6) * p.output +
    (u.cache_creation_input_tokens / 1e6) * p.cacheWrite +
    (u.cache_read_input_tokens / 1e6) * p.cacheRead
  );
}
