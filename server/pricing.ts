/**
 * Hardcoded pricing for Anthropic Claude and OpenAI GPT-5/GPT-6 families
 * (USD per million tokens).
 *
 * Checked against platform.claude.com/docs/en/about-claude/pricing and
 * developers.openai.com/api/docs/pricing on 2026-09-29.
 *
 * Notable gotchas:
 *  - Fable 5 is 2x the price of Opus ($10/$50 per M). Fable 5.1 keeps
 *    those rates but cuts cache reads from $1 to $0.25 per M. Mythos uses
 *    the same versioned rates.
 *  - Opus 4.5+ is THREE TIMES CHEAPER than the original Opus 4/4.1.
 *    Opus 5.5 is cheaper again ($4/$20) with cache reads at 0.05x input.
 *  - Sonnet 4.5 has 1M context with tiered pricing above 200k tokens;
 *    Sonnet 4.6 dropped that tier. Sonnet 5+ is $2/$10.
 *  - Opus fast mode (`usage.speed === "fast"`) is 6x on Opus 4.6 and 2x on
 *    Opus 4.8, 5 and 5.5.
 *  - OpenAI cached-input rate is consistently 10% of base input rate.
 *    GPT-5.6+ cache writes cost 1.25x the uncached input rate; older GPT
 *    models have cacheWrite set equal to cacheRead defensively.
 *  - GPT-5.4+ requests above 272k input tokens are billed at the
 *    long-context rate for the whole request.
 *  - GPT-5.6 Sol is on promotional pricing through at least 2026-11-21.
 *  - GPT-5.1 and GPT-5.1-codex price the same as base GPT-5 ($1.25/$10).
 *
 * Cache-write cost (Claude side) is the 5-minute ephemeral cache rate.
 */

export type ModelPricing = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Per-token rates above 200k tokens in the request — Sonnet 1M context. */
  tiered?: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
  /** Multiplier applied to total cost when speed === "fast". */
  fastMultiplier?: number;
  longContext?: { threshold: number; rates: ModelPricing };
};

const M = 1_000_000;

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
  // Opus 4.5, 4.6, 4.7. Only 4.6 had fast mode.
  input: 5 / M,
  output: 25 / M,
  cacheWrite: 6.25 / M,
  cacheRead: 0.5 / M,
  fastMultiplier: 6,
};

const OPUS_48: ModelPricing = {
  // Opus 4.8 and Opus 5.
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
  // Claude 3 Opus, Opus 4, Opus 4.1.
  input: 15 / M,
  output: 75 / M,
  cacheWrite: 18.75 / M,
  cacheRead: 1.5 / M,
};

const SONNET_TIERED: ModelPricing = {
  // Sonnet 4 / 4.5 — 1M context with tiered pricing above 200k.
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
  // Sonnet 4.6 — no tiered pricing.
  input: 3 / M,
  output: 15 / M,
  cacheWrite: 3.75 / M,
  cacheRead: 0.3 / M,
};

const SONNET_5: ModelPricing = {
  // Sonnet 5 and 5.5.
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

// --- OpenAI GPT-5 family ---
// Cached input is 10% of base input across the line (OpenAI's standard
// discount). Before GPT-5.6 there was no separate cache-write price, so
// those models use the cached-input rate defensively if `cc` is populated.

const GPT5_BASE: ModelPricing = {
  // gpt-5, gpt-5.1, gpt-5.1-codex, bare gpt-5-codex
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
  // 5.2 and 5.2-codex both at codex rate (no separate 5.2 base public yet).
  if (m.includes('gpt-5.3') || m.includes('gpt-5.2')) return GPT52_CODEX;
  if (m.includes('gpt-5.1')) return GPT5_BASE; // 5.1 and 5.1-codex same as 5
  if (m.includes('gpt-5-mini')) return GPT5_MINI;
  if (m.includes('gpt-5-nano')) return GPT5_NANO;
  if (m.includes('gpt-5')) return GPT5_BASE; // gpt-5, gpt-5-codex, gpt-5.0…
  return null;
}

type ModelVersion = { major: number; minor: number };

function modelVersion(model: string, family: string): ModelVersion | null {
  // Matches "opus-4-7", "opus-4.7", "opus-4-7-20260416", "opus-5-5[1m]", "opus-5".
  const match = model.match(new RegExp(`${family}-(\\d{1,2})(?:[-.](\\d{1,2}))?(?!\\d)`));
  if (!match) return null;
  return { major: parseInt(match[1]!, 10), minor: match[2] ? parseInt(match[2], 10) : 0 };
}

function isAtLeast(version: ModelVersion | null, major: number, minor: number): boolean {
  if (version === null) return false;
  return version.major > major || (version.major === major && version.minor >= minor);
}

/**
 * Resolve a model name to its pricing. Matches all the forms Claude Code
 * and providers emit: `claude-opus-4-7`, `claude-opus-4-7-20260416`,
 * `anthropic/claude-opus-4-7`, `us.anthropic.claude-opus-4-7`,
 * `vertex_ai/claude-opus-4-7`, plus bare aliases like `opus`/`sonnet`.
 *
 * Date-suffixed names are tricky: `opus-4-20250514` is legacy Opus 4 with
 * a release date, NOT "Opus 4.20". Version parts are at most 2 digits and
 * must not be followed by another digit, so 8-digit dates are rejected.
 */
export function getPricing(model: string): ModelPricing | null {
  const m = model.toLowerCase();

  if (m.includes('fable') || m.includes('mythos')) {
    return isAtLeast(modelVersion(m, '(?:fable|mythos)'), 5, 1) ? FABLE_51 : FABLE_5;
  }

  if (m.includes('haiku')) return HAIKU;

  if (m.includes('sonnet')) {
    const version = modelVersion(m, 'sonnet');
    if (isAtLeast(version, 5, 0)) return SONNET_5;
    // Sonnet 4.6 dropped the 1M context tier. Unknown bare "sonnet" → assume
    // tiered (matches the most-recent generation that still has the tier).
    if (isAtLeast(version, 4, 6)) return SONNET_FLAT;
    return SONNET_TIERED;
  }

  if (m.includes('opus')) {
    const version = modelVersion(m, 'opus');
    if (isAtLeast(version, 5, 5)) return OPUS_55;
    if (isAtLeast(version, 4, 8)) return OPUS_48;
    if (isAtLeast(version, 4, 5)) return OPUS_45;
    return OPUS_LEGACY;
  }

  if (m.includes('gpt-')) return getOpenAIPricing(m);

  return null;
}

const TIER_THRESHOLD = 200_000;

function requestPricing(model: string, inputTokens: number): ModelPricing | null {
  const p = getPricing(model);
  return p?.longContext && inputTokens > p.longContext.threshold ? p.longContext.rates : p;
}

function tieredCost(
  tokens: number,
  base: number,
  tiered: number | undefined,
): number {
  if (tokens <= 0) return 0;
  if (tiered == null || tokens <= TIER_THRESHOLD) return tokens * base;
  return TIER_THRESHOLD * base + (tokens - TIER_THRESHOLD) * tiered;
}

export type TokenCounts = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

export function costForRequest(
  tokens: TokenCounts,
  model: string,
  fast = false,
): number {
  const p = requestPricing(model, tokens.input + tokens.cacheWrite + tokens.cacheRead);
  if (!p) return 0;
  const cost =
    tieredCost(tokens.input, p.input, p.tiered?.input) +
    tieredCost(tokens.output, p.output, p.tiered?.output) +
    tieredCost(tokens.cacheWrite, p.cacheWrite, p.tiered?.cacheWrite) +
    tieredCost(tokens.cacheRead, p.cacheRead, p.tiered?.cacheRead);
  return fast && p.fastMultiplier ? cost * p.fastMultiplier : cost;
}

export type CostBreakdown = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

/**
 * Per-request cost split by token type. Tiering and the fast multiplier
 * apply per request, so this must be called before any roll-up — pricing
 * the summed tokens of several requests overcharges past the 200k tier.
 * Mirrors `costBreakdown` in src/pricing.ts; tests/pricing.test.ts pins it.
 */
export function costBreakdownForEntry(e: {
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
}): CostBreakdown {
  if (e.ci !== undefined || e.co !== undefined || e.cwc !== undefined || e.crc !== undefined) {
    return {
      input: e.ci ?? 0,
      output: e.co ?? 0,
      cacheWrite: e.cwc ?? 0,
      cacheRead: e.crc ?? 0,
    };
  }
  const p = requestPricing(e.m, e.i + e.cc + e.cr);
  if (!p) return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const mult = e.f && p.fastMultiplier ? p.fastMultiplier : 1;
  return {
    input: tieredCost(e.i, p.input, p.tiered?.input) * mult,
    output: tieredCost(e.o, p.output, p.tiered?.output) * mult,
    cacheWrite: tieredCost(e.cc, p.cacheWrite, p.tiered?.cacheWrite) * mult,
    cacheRead: tieredCost(e.cr, p.cacheRead, p.tiered?.cacheRead) * mult,
  };
}
