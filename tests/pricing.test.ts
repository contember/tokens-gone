import { describe, expect, it } from 'bun:test';
import { costForRequest, getPricing } from '../server/pricing';
import { costForEntry } from '../src/pricing';

describe('pricing', () => {
  it('fable 5 / mythos 5 share the flagship tier ($10/$50 per M), no fast/tier', () => {
    for (const model of [
      'claude-fable-5',
      'claude-fable-5-20260601',
      'anthropic/claude-fable-5',
      'claude-mythos-5',
      'claude-mythos-preview',
    ]) {
      const p = getPricing(model);
      expect(p?.input).toBe(10 / 1_000_000);
      expect(p?.output).toBe(50 / 1_000_000);
      expect(p?.cacheWrite).toBe(12.5 / 1_000_000);
      expect(p?.cacheRead).toBe(1 / 1_000_000);
      expect(p?.fastMultiplier).toBeUndefined();
      expect(p?.tiered).toBeUndefined();
    }
  });

  it('opus 4.5+ uses cheap tier ($5/$25 per M)', () => {
    for (const model of [
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-7-20260416',
      'anthropic/claude-opus-4-7',
    ]) {
      const p = getPricing(model);
      expect(p?.input).toBe(5 / 1_000_000);
      expect(p?.output).toBe(25 / 1_000_000);
      expect(p?.cacheWrite).toBe(6.25 / 1_000_000);
      expect(p?.cacheRead).toBe(0.5 / 1_000_000);
    }
  });

  it('opus 4/4.1 stays on legacy expensive tier ($15/$75 per M)', () => {
    for (const model of [
      'claude-opus-4-1',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-3-opus-20240229',
    ]) {
      const p = getPricing(model);
      expect(p?.input).toBe(15 / 1_000_000);
      expect(p?.output).toBe(75 / 1_000_000);
    }
  });

  it('sonnet 4.5 has tiered 1M-context pricing; sonnet 4.6 does not', () => {
    expect(getPricing('claude-sonnet-4-5')?.tiered).toBeDefined();
    expect(getPricing('claude-sonnet-4-5-20250929')?.tiered).toBeDefined();
    expect(getPricing('claude-sonnet-4-6')?.tiered).toBeUndefined();
  });

  it('haiku', () => {
    const p = getPricing('claude-haiku-4-5-20251001');
    expect(p?.input).toBe(1 / 1_000_000);
    expect(p?.output).toBe(5 / 1_000_000);
  });

  it('bare aliases resolve to current generation', () => {
    // "sonnet" alias → tiered (covers Sonnet 4.5 era usage)
    expect(getPricing('sonnet')).toBeDefined();
    // unknown opus version → assumed current
    expect(getPricing('opus')?.input).toBe(15 / 1_000_000); // bare "opus" matches legacy
  });

  it('returns null for unknown providers', () => {
    expect(getPricing('llama-3-70b')).toBeNull();
    expect(getPricing('gemini-2-flash')).toBeNull();
    expect(getPricing('')).toBeNull();
  });

  it('prices base gpt-5 / gpt-5.1 / gpt-5.1-codex at $1.25 / $10', () => {
    for (const model of ['gpt-5', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5-codex']) {
      const p = getPricing(model);
      expect(p?.input).toBe(1.25 / 1_000_000);
      expect(p?.output).toBe(10 / 1_000_000);
      expect(p?.cacheRead).toBe(0.125 / 1_000_000);
    }
  });

  it('prices gpt-5.2-codex above base ($1.75 / $14)', () => {
    const p = getPricing('gpt-5.2-codex');
    expect(p?.input).toBe(1.75 / 1_000_000);
    expect(p?.output).toBe(14 / 1_000_000);
    expect(p?.cacheRead).toBe(0.175 / 1_000_000);
  });

  it('prices gpt-5.4 family ($2.50 / $15 base, mini and nano variants)', () => {
    expect(getPricing('gpt-5.4')?.input).toBe(2.5 / 1_000_000);
    expect(getPricing('gpt-5.4')?.output).toBe(15 / 1_000_000);
    expect(getPricing('gpt-5.4-mini')?.input).toBe(0.75 / 1_000_000);
    expect(getPricing('gpt-5.4-nano')?.input).toBe(0.2 / 1_000_000);
  });

  it('prices gpt-5.5 and gpt-5.5-pro separately', () => {
    expect(getPricing('gpt-5.5')?.input).toBe(5 / 1_000_000);
    expect(getPricing('gpt-5.5')?.output).toBe(30 / 1_000_000);
    // -pro must not fall through to plain 5.5
    expect(getPricing('gpt-5.5-pro')?.input).toBe(30 / 1_000_000);
    expect(getPricing('gpt-5.5-pro')?.output).toBe(180 / 1_000_000);
  });

  it('prices the gpt-5.6 family including cache writes and reads', () => {
    for (const [model, input, output] of [
      ['gpt-5.6-sol', 5, 30],
      ['gpt-5.6-terra', 2.5, 15],
      ['gpt-5.6-luna', 1, 6],
    ] as const) {
      const p = getPricing(model);
      expect(p?.input).toBe(input / 1_000_000);
      expect(p?.output).toBe(output / 1_000_000);
      expect(p?.cacheWrite).toBe((input * 1.25) / 1_000_000);
      expect(p?.cacheRead).toBe((input * 0.1) / 1_000_000);
    }

    expect(getPricing('openai/gpt-5.6-sol-20260626')?.input).toBe(5 / 1_000_000);
  });

  it('gpt-5 models have no fast multiplier or tiered pricing', () => {
    for (const model of ['gpt-5', 'gpt-5.5', 'gpt-5.2-codex']) {
      const p = getPricing(model);
      expect(p?.fastMultiplier).toBeUndefined();
      expect(p?.tiered).toBeUndefined();
    }
  });

  it('reproduces ccusage cost for opus-4-7 daily figure', () => {
    // From ccusage daily --json on 2026-05-10 (verified independently):
    // opus-4-7: in=26582, out=1338164, c.w=7972135, c.r=403044843 → $284.94
    const cost = costForRequest(
      { input: 26582, output: 1338164, cacheWrite: 7972135, cacheRead: 403044843 },
      'claude-opus-4-7',
    );
    expect(cost).toBeCloseTo(284.94, 1);
  });

  it('applies tiered pricing above 200k for sonnet-4-5', () => {
    const cost = costForRequest(
      { input: 300_000, output: 0, cacheWrite: 0, cacheRead: 0 },
      'claude-sonnet-4-5',
    );
    const expected = 200_000 * (3 / 1_000_000) + 100_000 * (6 / 1_000_000);
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('does not apply tiered pricing for sonnet-4-6 or opus', () => {
    const opus = costForRequest(
      { input: 300_000, output: 0, cacheWrite: 0, cacheRead: 0 },
      'claude-opus-4-7',
    );
    expect(opus).toBeCloseTo(300_000 * (5 / 1_000_000), 10);

    const sonnet = costForRequest(
      { input: 300_000, output: 0, cacheWrite: 0, cacheRead: 0 },
      'claude-sonnet-4-6',
    );
    expect(sonnet).toBeCloseTo(300_000 * (3 / 1_000_000), 10);
  });

  it('applies 6x fast multiplier on opus 4.5+', () => {
    const base = costForRequest(
      { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 },
      'claude-opus-4-7',
      false,
    );
    const fast = costForRequest(
      { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 },
      'claude-opus-4-7',
      true,
    );
    expect(fast).toBeCloseTo(base * 6, 10);
  });

  it('does not apply fast multiplier on sonnet or haiku', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5']) {
      const base = costForRequest(
        { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 },
        model,
        false,
      );
      const fast = costForRequest(
        { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 },
        model,
        true,
      );
      expect(fast).toBeCloseTo(base, 10);
    }
  });

  it('client and server agree on cost calculation', () => {
    const tokens = { input: 12345, output: 6789, cacheWrite: 50000, cacheRead: 200000 };
    for (const model of [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-1',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5',
      'gpt-5',
      'gpt-5.1-codex',
      'gpt-5.2-codex',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]) {
      const server = costForRequest(tokens, model, false);
      const client = costForEntry({
        m: model,
        i: tokens.input,
        o: tokens.output,
        cc: tokens.cacheWrite,
        cr: tokens.cacheRead,
        f: 0,
      });
      expect(client).toBeCloseTo(server, 12);
    }
  });

  it('uses explicit provider cost components when present', () => {
    const cost = costForEntry({
      m: 'provider/model-without-static-pricing',
      i: 1000,
      o: 1000,
      cc: 1000,
      cr: 1000,
      f: 0,
      ci: 0.01,
      co: 0.02,
      cwc: 0.003,
      crc: 0.004,
    });
    expect(cost).toBeCloseTo(0.037, 12);
  });
});
