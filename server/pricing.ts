/**
 * Hardcoded pricing for Anthropic Claude and OpenAI GPT-5 family
 * (USD per million tokens).
 *
 * Sources cross-checked against Anthropic's pricing page, OpenAI's pricing
 * page, and several third-party rate trackers on 2026-05-11. OpenAI bumped
 * rates across the 5.x line in March/April 2026 — the codex variants
 * (gpt-5.2-codex in particular) cost more than base gpt-5.
 *
 * Notable gotchas:
 *  - Fable 5 is the new flagship, 2x the price of Opus ($10/$50 per M).
 *    Full 1M context at standard pricing; no fast service tier. Mythos 5
 *    (and Mythos Preview) share this exact tier.
 *  - Opus 4.5+ is THREE TIMES CHEAPER than the original Opus 4/4.1.
 *  - Sonnet 4.5 has 1M context with tiered pricing above 200k tokens;
 *    Sonnet 4.6 dropped that tier.
 *  - Opus 4.6+ has a "fast" service tier billed at 6× the standard rate;
 *    the JSONL records this as `usage.speed === "fast"`.
 *  - OpenAI cached-input rate is consistently 10% of base input rate.
 *    There's no cache-write concept on the OpenAI side, so cacheWrite is
 *    set equal to cacheRead defensively (Codex entries always have cc=0).
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
};

const M = 1_000_000;

const FABLE: ModelPricing = {
  // Claude Fable 5 (and Mythos 5 / Mythos Preview, same pricing) — new
  // flagship tier, 2x Opus. Full 1M context at standard pricing (no tier
  // above 200k) and no fast-mode variant.
  input: 10 / M,
  output: 50 / M,
  cacheWrite: 12.5 / M,
  cacheRead: 1 / M,
};

const OPUS_NEW: ModelPricing = {
  // Opus 4.5, 4.6, 4.7 and presumably future Opus releases.
  input: 5 / M,
  output: 25 / M,
  cacheWrite: 6.25 / M,
  cacheRead: 0.5 / M,
  fastMultiplier: 6,
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
  // Sonnet 4.6+ — no tiered pricing.
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

// --- OpenAI GPT-5 family ---
// Cached input is 10% of base input across the line (OpenAI's standard
// discount). cacheWrite is set = cacheRead because OpenAI has no separate
// write concept; if a future provider stuffed something into `cc` we'd
// still bill at the cached rate rather than free.

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

const GPT52_CODEX: ModelPricing = {
  // Dedicated codex agent variant. Priced above base 5.x.
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

const GPT55: ModelPricing = {
  input: 5 / M,
  output: 30 / M,
  cacheWrite: 0.5 / M,
  cacheRead: 0.5 / M,
};

const GPT55_PRO: ModelPricing = {
  input: 30 / M,
  output: 180 / M,
  cacheWrite: 3 / M,
  cacheRead: 3 / M,
};

/**
 * Match an OpenAI GPT-5 family model name to its pricing.
 * Order matters: most specific substrings first so e.g. `gpt-5.5-pro`
 * doesn't fall through to `gpt-5.5`, and `gpt-5.1-codex` doesn't get
 * mistaken for `gpt-5-codex`.
 */
function getOpenAIPricing(m: string): ModelPricing | null {
  if (m.includes('gpt-5.5-pro')) return GPT55_PRO;
  if (m.includes('gpt-5.5')) return GPT55;
  if (m.includes('gpt-5.4-mini')) return GPT54_MINI;
  if (m.includes('gpt-5.4-nano')) return GPT54_NANO;
  if (m.includes('gpt-5.4')) return GPT54;
  // 5.2 and 5.2-codex both at codex rate (no separate 5.2 base public yet).
  if (m.includes('gpt-5.2')) return GPT52_CODEX;
  if (m.includes('gpt-5.1')) return GPT5_BASE; // 5.1 and 5.1-codex same as 5
  if (m.includes('gpt-5-mini')) return GPT5_MINI;
  if (m.includes('gpt-5-nano')) return GPT5_NANO;
  if (m.includes('gpt-5')) return GPT5_BASE; // gpt-5, gpt-5-codex, gpt-5.0…
  return null;
}

/**
 * Resolve a model name to its pricing. Matches all the forms Claude Code
 * and providers emit: `claude-opus-4-7`, `claude-opus-4-7-20260416`,
 * `anthropic/claude-opus-4-7`, `us.anthropic.claude-opus-4-7`,
 * `vertex_ai/claude-opus-4-7`, plus bare aliases like `opus`/`sonnet`.
 *
 * Date-suffixed names are tricky: `opus-4-20250514` is legacy Opus 4 with
 * a release date, NOT "Opus 4.20". The version-extraction regex caps the
 * minor at 2 digits and requires a dash/end after it, so 8-digit dates
 * are rejected by the version match and fall through to the legacy branch.
 */
function minorVersion(model: string, family: string): number | null {
  // Match e.g. "opus-4-7" or "opus-4-7-20260416" — minor is at most 2 digits
  // and must be followed by `-` or end-of-string, ruling out date suffixes.
  const m = model.match(new RegExp(`${family}-4-(\\d{1,2})(?:-|$)`));
  if (m) return parseInt(m[1]!, 10);
  // Match "opus-5" / "opus-10" — major-only, future generations.
  const major = model.match(new RegExp(`${family}-(\\d{1,2})(?:-|$)`));
  if (major) {
    const v = parseInt(major[1]!, 10);
    if (v >= 5) return 50; // synthetic minor; just signals "new"
  }
  return null;
}

export function getPricing(model: string): ModelPricing | null {
  const m = model.toLowerCase();

  if (m.includes('fable') || m.includes('mythos')) return FABLE;

  if (m.includes('haiku')) return HAIKU;

  if (m.includes('sonnet')) {
    const minor = minorVersion(m, 'sonnet');
    // Sonnet 4.6+ dropped the 1M context tier. Sonnet 4.5 and earlier 4.x
    // keep tiered pricing. Unknown bare "sonnet" → assume tiered (matches
    // the most-recent generation that still has the tier).
    if (minor !== null && minor >= 6) return SONNET_FLAT;
    return SONNET_TIERED;
  }

  if (m.includes('opus')) {
    const minor = minorVersion(m, 'opus');
    // Opus 4.5 and later are 3x cheaper than Opus 3/4/4.1.
    if (minor !== null && minor >= 5) return OPUS_NEW;
    return OPUS_LEGACY;
  }

  if (m.includes('gpt-5')) return getOpenAIPricing(m);

  return null;
}

const TIER_THRESHOLD = 200_000;

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
  const p = getPricing(model);
  if (!p) return 0;
  const cost =
    tieredCost(tokens.input, p.input, p.tiered?.input) +
    tieredCost(tokens.output, p.output, p.tiered?.output) +
    tieredCost(tokens.cacheWrite, p.cacheWrite, p.tiered?.cacheWrite) +
    tieredCost(tokens.cacheRead, p.cacheRead, p.tiered?.cacheRead);
  return fast && p.fastMultiplier ? cost * p.fastMultiplier : cost;
}
