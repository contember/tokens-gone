/**
 * Client-side pricing — duplicated from server so the SPA can recompute
 * costs locally on every filter change without an extra round-trip. The
 * two must agree; tests/pricing.test.ts pins that invariant.
 *
 * See server/pricing.ts for the full rationale on pricing tiers.
 */

const M = 1_000_000;

type ModelPricing = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  tiered?: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
  fastMultiplier?: number;
};

const OPUS_NEW: ModelPricing = {
  input: 5 / M,
  output: 25 / M,
  cacheWrite: 6.25 / M,
  cacheRead: 0.5 / M,
  fastMultiplier: 6,
};

const OPUS_LEGACY: ModelPricing = {
  input: 15 / M,
  output: 75 / M,
  cacheWrite: 18.75 / M,
  cacheRead: 1.5 / M,
};

const SONNET_TIERED: ModelPricing = {
  input: 3 / M,
  output: 15 / M,
  cacheWrite: 3.75 / M,
  cacheRead: 0.3 / M,
  tiered: {
    input: 6 / M,
    output: 22.5 / M,
    cacheWrite: 7.5 / M,
    cacheRead: 0.6 / M,
  },
};

const SONNET_FLAT: ModelPricing = {
  input: 3 / M,
  output: 15 / M,
  cacheWrite: 3.75 / M,
  cacheRead: 0.3 / M,
};

const HAIKU: ModelPricing = {
  input: 1 / M,
  output: 5 / M,
  cacheWrite: 1.25 / M,
  cacheRead: 0.1 / M,
};

// Module-level regex cache: previously these were rebuilt on every call
// (`new RegExp(...)` inside `minorVersion`), which dominated profile time
// once a dataset hit 100k+ entries.
const RE_SONNET_4 = /sonnet-4-(\d{1,2})(?:-|$)/;
const RE_SONNET_MAJOR = /sonnet-(\d{1,2})(?:-|$)/;
const RE_OPUS_4 = /opus-4-(\d{1,2})(?:-|$)/;
const RE_OPUS_MAJOR = /opus-(\d{1,2})(?:-|$)/;

function minorVersion(model: string, four: RegExp, major: RegExp): number | null {
  const m = model.match(four);
  if (m) return parseInt(m[1]!, 10);
  const j = model.match(major);
  if (j) {
    const v = parseInt(j[1]!, 10);
    if (v >= 5) return 50;
  }
  return null;
}

// Memoize getPricing by model string. Datasets repeat the same handful of
// model names hundreds of thousands of times, so the cache hit rate is
// effectively 1.0 after warmup.
const PRICING_CACHE = new Map<string, ModelPricing | null>();

export function getPricing(model: string): ModelPricing | null {
  const cached = PRICING_CACHE.get(model);
  if (cached !== undefined) return cached;
  const m = model.toLowerCase();
  let result: ModelPricing | null;
  if (m.includes('haiku')) {
    result = HAIKU;
  } else if (m.includes('sonnet')) {
    const minor = minorVersion(m, RE_SONNET_4, RE_SONNET_MAJOR);
    result = minor !== null && minor >= 6 ? SONNET_FLAT : SONNET_TIERED;
  } else if (m.includes('opus')) {
    const minor = minorVersion(m, RE_OPUS_4, RE_OPUS_MAJOR);
    result = minor !== null && minor >= 5 ? OPUS_NEW : OPUS_LEGACY;
  } else {
    result = null;
  }
  PRICING_CACHE.set(model, result);
  return result;
}

const TIER_THRESHOLD = 200_000;

function tieredCost(tokens: number, base: number, tiered: number | undefined): number {
  if (tokens <= 0) return 0;
  if (tiered == null || tokens <= TIER_THRESHOLD) return tokens * base;
  return TIER_THRESHOLD * base + (tokens - TIER_THRESHOLD) * tiered;
}

export function costForEntry(e: {
  m: string;
  i: number;
  o: number;
  cc: number;
  cr: number;
  f: 0 | 1;
}): number {
  const p = getPricing(e.m);
  if (!p) return 0;
  const cost =
    tieredCost(e.i, p.input, p.tiered?.input) +
    tieredCost(e.o, p.output, p.tiered?.output) +
    tieredCost(e.cc, p.cacheWrite, p.tiered?.cacheWrite) +
    tieredCost(e.cr, p.cacheRead, p.tiered?.cacheRead);
  return e.f && p.fastMultiplier ? cost * p.fastMultiplier : cost;
}

/**
 * Cost broken down by token type, in one pass. Replaces the pattern of
 * calling `costForEntry` four times with three of the four fields zeroed
 * out — that pattern allocated O(N) intermediate objects and did 4×
 * pricing lookups per entry. This is one lookup, one tier check, four
 * multiplies. Used for the hero decomposition strip and any per-row
 * type breakdown.
 */
export function costBreakdown(e: {
  m: string;
  i: number;
  o: number;
  cc: number;
  cr: number;
  f: 0 | 1;
}): { input: number; output: number; cwrite: number; cread: number; total: number } {
  const p = getPricing(e.m);
  if (!p) return { input: 0, output: 0, cwrite: 0, cread: 0, total: 0 };
  const mult = e.f && p.fastMultiplier ? p.fastMultiplier : 1;
  const input = tieredCost(e.i, p.input, p.tiered?.input) * mult;
  const output = tieredCost(e.o, p.output, p.tiered?.output) * mult;
  const cwrite = tieredCost(e.cc, p.cacheWrite, p.tiered?.cacheWrite) * mult;
  const cread = tieredCost(e.cr, p.cacheRead, p.tiered?.cacheRead) * mult;
  return { input, output, cwrite, cread, total: input + output + cwrite + cread };
}
