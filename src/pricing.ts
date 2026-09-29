/**
 * Client-side pricing — duplicated from server, which must agree with it;
 * tests/pricing.test.ts pins that invariant.
 *
 * Rolled-up rows arrive already priced (`rowCost`); this is for the raw
 * per-request entries the session detail fetches on demand.
 *
 * See server/pricing.ts for the full rationale on pricing tiers.
 */

import type { UsageRow } from './types';

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
  longContext?: { threshold: number; rates: ModelPricing };
};

const FABLE_5: ModelPricing = {
  input: 10 / M,
  output: 50 / M,
  cacheWrite: 12.5 / M,
  cacheRead: 1 / M,
};

const FABLE_51: ModelPricing = {
  input: 10 / M,
  output: 50 / M,
  cacheWrite: 12.5 / M,
  cacheRead: 0.25 / M,
};

const OPUS_45: ModelPricing = {
  input: 5 / M,
  output: 25 / M,
  cacheWrite: 6.25 / M,
  cacheRead: 0.5 / M,
  fastMultiplier: 6,
};

const OPUS_48: ModelPricing = {
  input: 5 / M,
  output: 25 / M,
  cacheWrite: 6.25 / M,
  cacheRead: 0.5 / M,
  fastMultiplier: 2,
};

const OPUS_55: ModelPricing = {
  input: 4 / M,
  output: 20 / M,
  cacheWrite: 5 / M,
  cacheRead: 0.2 / M,
  fastMultiplier: 2,
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

const SONNET_5: ModelPricing = {
  input: 2 / M,
  output: 10 / M,
  cacheWrite: 2.5 / M,
  cacheRead: 0.2 / M,
};

const HAIKU: ModelPricing = {
  input: 1 / M,
  output: 5 / M,
  cacheWrite: 1.25 / M,
  cacheRead: 0.1 / M,
};

// OpenAI GPT-5 family — see server/pricing.ts for rationale on per-model
// rates. GPT-5.6+ has a separate 1.25x cache-write rate.
const GPT5_BASE: ModelPricing = {
  input: 1.25 / M,
  output: 10 / M,
  cacheWrite: 0.125 / M,
  cacheRead: 0.125 / M,
};
const GPT5_MINI: ModelPricing = {
  input: 0.25 / M,
  output: 2 / M,
  cacheWrite: 0.025 / M,
  cacheRead: 0.025 / M,
};
const GPT5_NANO: ModelPricing = {
  input: 0.05 / M,
  output: 0.4 / M,
  cacheWrite: 0.005 / M,
  cacheRead: 0.005 / M,
};
// gpt-5.2, gpt-5.2-codex and gpt-5.3-codex. Priced above base 5.x.
const GPT52_CODEX: ModelPricing = {
  input: 1.75 / M,
  output: 14 / M,
  cacheWrite: 0.175 / M,
  cacheRead: 0.175 / M,
};
const GPT54: ModelPricing = {
  input: 2.5 / M,
  output: 15 / M,
  cacheWrite: 0.25 / M,
  cacheRead: 0.25 / M,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 5 / M,
      output: 22.5 / M,
      cacheWrite: 0.5 / M,
      cacheRead: 0.5 / M,
    },
  },
};
const GPT54_MINI: ModelPricing = {
  input: 0.75 / M,
  output: 4.5 / M,
  cacheWrite: 0.075 / M,
  cacheRead: 0.075 / M,
};
const GPT54_NANO: ModelPricing = {
  input: 0.2 / M,
  output: 1.25 / M,
  cacheWrite: 0.02 / M,
  cacheRead: 0.02 / M,
};
const GPT54_PRO: ModelPricing = {
  input: 30 / M,
  output: 180 / M,
  cacheWrite: 3 / M,
  cacheRead: 3 / M,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 60 / M,
      output: 270 / M,
      cacheWrite: 6 / M,
      cacheRead: 6 / M,
    },
  },
};
const GPT55: ModelPricing = {
  input: 5 / M,
  output: 30 / M,
  cacheWrite: 0.5 / M,
  cacheRead: 0.5 / M,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 10 / M,
      output: 45 / M,
      cacheWrite: 1 / M,
      cacheRead: 1 / M,
    },
  },
};
const GPT55_PRO: ModelPricing = {
  input: 30 / M,
  output: 180 / M,
  cacheWrite: 3 / M,
  cacheRead: 3 / M,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 60 / M,
      output: 270 / M,
      cacheWrite: 6 / M,
      cacheRead: 6 / M,
    },
  },
};
const GPT56_SOL: ModelPricing = {
  input: 4 / M,
  output: 20 / M,
  cacheWrite: 5 / M,
  cacheRead: 0.4 / M,
  fastMultiplier: 2,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 8 / M,
      output: 30 / M,
      cacheWrite: 10 / M,
      cacheRead: 0.8 / M,
      fastMultiplier: 2,
    },
  },
};
const GPT56_TERRA: ModelPricing = {
  input: 2 / M,
  output: 12 / M,
  cacheWrite: 2.5 / M,
  cacheRead: 0.2 / M,
  fastMultiplier: 2,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 4 / M,
      output: 18 / M,
      cacheWrite: 5 / M,
      cacheRead: 0.4 / M,
      fastMultiplier: 2,
    },
  },
};
const GPT56_LUNA: ModelPricing = {
  input: 0.2 / M,
  output: 1.2 / M,
  cacheWrite: 0.25 / M,
  cacheRead: 0.02 / M,
  fastMultiplier: 2,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 0.4 / M,
      output: 1.8 / M,
      cacheWrite: 0.5 / M,
      cacheRead: 0.04 / M,
      fastMultiplier: 2,
    },
  },
};
// https://developers.openai.com/api/docs/models/gpt-6-astra
const GPT6_ASTRA: ModelPricing = {
  input: 10 / M,
  output: 50 / M,
  cacheWrite: 12.5 / M,
  cacheRead: 1 / M,
  fastMultiplier: 2,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 20 / M,
      output: 75 / M,
      cacheWrite: 25 / M,
      cacheRead: 2 / M,
      fastMultiplier: 2,
    },
  },
};
const GPT6_SOL: ModelPricing = {
  input: 2 / M,
  output: 10 / M,
  cacheWrite: 2.5 / M,
  cacheRead: 0.2 / M,
  fastMultiplier: 2,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 4 / M,
      output: 15 / M,
      cacheWrite: 5 / M,
      cacheRead: 0.4 / M,
      fastMultiplier: 2,
    },
  },
};
const GPT6_LUNA: ModelPricing = {
  input: 0.1 / M,
  output: 0.5 / M,
  cacheWrite: 0.125 / M,
  cacheRead: 0.01 / M,
  fastMultiplier: 2,
  longContext: {
    threshold: 272_000,
    rates: {
      input: 0.2 / M,
      output: 0.75 / M,
      cacheWrite: 0.25 / M,
      cacheRead: 0.02 / M,
      fastMultiplier: 2,
    },
  },
};

function getOpenAIPricing(m: string): ModelPricing | null {
  if (m.includes('gpt-6-astra')) return GPT6_ASTRA;
  if (m.includes('gpt-6-sol')) return GPT6_SOL;
  if (m.includes('gpt-6-luna')) return GPT6_LUNA;
  if (m.includes('gpt-5.6-sol')) return GPT56_SOL;
  if (m.includes('gpt-5.6-terra')) return GPT56_TERRA;
  if (m.includes('gpt-5.6-luna')) return GPT56_LUNA;
  if (m.includes('gpt-5.5-pro')) return GPT55_PRO;
  if (m.includes('gpt-5.5')) return GPT55;
  if (m.includes('gpt-5.4-pro')) return GPT54_PRO;
  if (m.includes('gpt-5.4-mini')) return GPT54_MINI;
  if (m.includes('gpt-5.4-nano')) return GPT54_NANO;
  if (m.includes('gpt-5.4')) return GPT54;
  if (m.includes('gpt-5.3') || m.includes('gpt-5.2')) return GPT52_CODEX;
  if (m.includes('gpt-5.1')) return GPT5_BASE;
  if (m.includes('gpt-5-mini')) return GPT5_MINI;
  if (m.includes('gpt-5-nano')) return GPT5_NANO;
  if (m.includes('gpt-5')) return GPT5_BASE;
  return null;
}

// Module-level regex cache: previously these were rebuilt on every call,
// which dominated profile time once a dataset hit 100k+ entries.
const RE_FABLE = /(?:fable|mythos)-(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/;
const RE_SONNET = /sonnet-(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/;
const RE_OPUS = /opus-(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/;

type ModelVersion = { major: number; minor: number };

function modelVersion(model: string, pattern: RegExp): ModelVersion | null {
  const match = model.match(pattern);
  if (!match) return null;
  return { major: parseInt(match[1]!, 10), minor: match[2] ? parseInt(match[2], 10) : 0 };
}

function isAtLeast(version: ModelVersion | null, major: number, minor: number): boolean {
  if (version === null) return false;
  return version.major > major || (version.major === major && version.minor >= minor);
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
  if (m.includes('fable') || m.includes('mythos')) {
    result = isAtLeast(modelVersion(m, RE_FABLE), 5, 1) ? FABLE_51 : FABLE_5;
  } else if (m.includes('haiku')) {
    result = HAIKU;
  } else if (m.includes('sonnet')) {
    const version = modelVersion(m, RE_SONNET);
    if (isAtLeast(version, 5, 0)) result = SONNET_5;
    else if (isAtLeast(version, 4, 6)) result = SONNET_FLAT;
    else result = SONNET_TIERED;
  } else if (m.includes('opus')) {
    const version = modelVersion(m, RE_OPUS);
    if (isAtLeast(version, 5, 5)) result = OPUS_55;
    else if (isAtLeast(version, 4, 8)) result = OPUS_48;
    else if (isAtLeast(version, 4, 5)) result = OPUS_45;
    else result = OPUS_LEGACY;
  } else if (m.includes('gpt-')) {
    result = getOpenAIPricing(m);
  } else {
    result = null;
  }
  PRICING_CACHE.set(model, result);
  return result;
}

const TIER_THRESHOLD = 200_000;

function requestPricing(model: string, inputTokens: number): ModelPricing | null {
  const p = getPricing(model);
  return p?.longContext && inputTokens > p.longContext.threshold ? p.longContext.rates : p;
}

function tieredCost(tokens: number, base: number, tiered: number | undefined): number {
  if (tokens <= 0) return 0;
  if (tiered == null || tokens <= TIER_THRESHOLD) return tokens * base;
  return TIER_THRESHOLD * base + (tokens - TIER_THRESHOLD) * tiered;
}

/**
 * Cost of a rolled-up row. The server priced every request before summing
 * them (tiers and the fast multiplier apply per request), so the row's own
 * token counts must never be re-priced — use these numbers as they are.
 */
export function rowCost(r: UsageRow): number {
  return r.ci + r.co + r.cwc + r.crc;
}

export function costForEntry(e: {
  m: string;
  i: number;
  o: number;
  cc: number;
  cr: number;
  f: 0 | 1;
  ci?: number;
  co?: number;
  cwc?: number;
  crc?: number;
}): number {
  const explicit = explicitCost(e);
  if (explicit !== null) return explicit;
  const p = requestPricing(e.m, e.i + e.cc + e.cr);
  if (!p) return 0;
  const cost =
    tieredCost(e.i, p.input, p.tiered?.input) +
    tieredCost(e.o, p.output, p.tiered?.output) +
    tieredCost(e.cc, p.cacheWrite, p.tiered?.cacheWrite) +
    tieredCost(e.cr, p.cacheRead, p.tiered?.cacheRead);
  return e.f && p.fastMultiplier ? cost * p.fastMultiplier : cost;
}

/**
 * Cost broken down by token type, in one pass. The client counterpart of
 * the server's `costBreakdownForEntry`, which is what fills a row's
 * `ci`/`co`/`cwc`/`crc`; tests/pricing.test.ts pins the two together.
 */
export function costBreakdown(e: {
  m: string;
  i: number;
  o: number;
  cc: number;
  cr: number;
  f: 0 | 1;
  ci?: number;
  co?: number;
  cwc?: number;
  crc?: number;
}): { input: number; output: number; cwrite: number; cread: number; total: number } {
  const explicit = explicitCostBreakdown(e);
  if (explicit) return explicit;
  const p = requestPricing(e.m, e.i + e.cc + e.cr);
  if (!p) return { input: 0, output: 0, cwrite: 0, cread: 0, total: 0 };
  const mult = e.f && p.fastMultiplier ? p.fastMultiplier : 1;
  const input = tieredCost(e.i, p.input, p.tiered?.input) * mult;
  const output = tieredCost(e.o, p.output, p.tiered?.output) * mult;
  const cwrite = tieredCost(e.cc, p.cacheWrite, p.tiered?.cacheWrite) * mult;
  const cread = tieredCost(e.cr, p.cacheRead, p.tiered?.cacheRead) * mult;
  return { input, output, cwrite, cread, total: input + output + cwrite + cread };
}

function explicitCost(e: {
  ci?: number;
  co?: number;
  cwc?: number;
  crc?: number;
}): number | null {
  const b = explicitCostBreakdown(e);
  return b ? b.total : null;
}

function explicitCostBreakdown(e: {
  ci?: number;
  co?: number;
  cwc?: number;
  crc?: number;
}): { input: number; output: number; cwrite: number; cread: number; total: number } | null {
  const has =
    e.ci !== undefined ||
    e.co !== undefined ||
    e.cwc !== undefined ||
    e.crc !== undefined;
  if (!has) return null;
  const input = e.ci ?? 0;
  const output = e.co ?? 0;
  const cwrite = e.cwc ?? 0;
  const cread = e.crc ?? 0;
  return { input, output, cwrite, cread, total: input + output + cwrite + cread };
}
