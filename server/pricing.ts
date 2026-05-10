/**
 * Hardcoded Anthropic Claude pricing (USD per million tokens).
 *
 * Sources cross-checked against Anthropic's public pricing page and the
 * LiteLLM `model_prices_and_context_window.json` dataset on 2026-05-11.
 *
 * Notable gotchas:
 *  - Opus 4.5/4.6/4.7 is THREE TIMES CHEAPER than the original Opus 4/4.1.
 *    Anthropic dropped Opus rates with the 4.5 generation. Tools that hardcode
 *    "Opus = $15/$75" overestimate costs by 3× on any model from 4.5 onward.
 *  - Sonnet 4.5 has 1M context with tiered pricing above 200k tokens. Sonnet
 *    4.6 dropped the 1M context tier — no tiered rates in current pricing.
 *  - Opus 4.6+ has a "fast" service tier billed at 6× the standard rate;
 *    the JSONL records this as `usage.speed === "fast"`.
 *
 * Cache-write cost here is the 5-minute ephemeral cache rate (the default
 * for Claude Code). Anthropic also offers 1h cache at a higher rate, but
 * the JSONL doesn't separate the two cleanly so we use one rate.
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
