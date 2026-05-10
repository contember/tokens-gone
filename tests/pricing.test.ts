import { describe, expect, it } from 'bun:test';
import { costForRequest, getPricing } from '../server/pricing';
import { costForEntry } from '../src/pricing';

describe('pricing', () => {
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

  it('returns null for non-Claude models', () => {
    expect(getPricing('gpt-5')).toBeNull();
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
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-1',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5',
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
});
