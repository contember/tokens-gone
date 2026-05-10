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

function minorVersion(model: string, family: string): number | null {
  const m = model.match(new RegExp(`${family}-4-(\\d{1,2})(?:-|$)`));
  if (m) return parseInt(m[1]!, 10);
  const major = model.match(new RegExp(`${family}-(\\d{1,2})(?:-|$)`));
  if (major) {
    const v = parseInt(major[1]!, 10);
    if (v >= 5) return 50;
  }
  return null;
}

export function getPricing(model: string): ModelPricing | null {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return HAIKU;
  if (m.includes('sonnet')) {
    const minor = minorVersion(m, 'sonnet');
    if (minor !== null && minor >= 6) return SONNET_FLAT;
    return SONNET_TIERED;
  }
  if (m.includes('opus')) {
    const minor = minorVersion(m, 'opus');
    if (minor !== null && minor >= 5) return OPUS_NEW;
    return OPUS_LEGACY;
  }
  return null;
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
