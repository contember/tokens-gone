import { describe, expect, it } from 'bun:test';
import { ROLLUP_BUCKET_MS, rollupEntries } from '../server/rollup';
import type { Entry } from '../server/types';

/** Bucket-aligned so offsets in the tests are unambiguous. */
const T0 = Math.floor(Date.parse('2026-04-15T10:00:00Z') / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;

function entry(over: Partial<Entry> = {}): Entry {
  return {
    t: T0,
    p: 'foo',
    s: 'sess-1',
    m: 'claude-sonnet-4-6',
    i: 100,
    o: 50,
    cc: 1000,
    cr: 5000,
    f: 0,
    ...over,
  };
}

describe('rollupEntries', () => {
  it('collapses requests that share session, model, fast mode and bucket', () => {
    const rows = rollupEntries([
      entry({ t: T0 }),
      entry({ t: T0 + 60_000 }),
      entry({ t: T0 + 120_000 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n).toBe(3);
    expect(rows[0]!.i).toBe(300);
    expect(rows[0]!.o).toBe(150);
    expect(rows[0]!.cc).toBe(3000);
    expect(rows[0]!.cr).toBe(15000);
  });

  it('spans t..te across the requests it collapsed', () => {
    const rows = rollupEntries([entry({ t: T0 + 120_000 }), entry({ t: T0 })]);
    expect(rows[0]!.t).toBe(T0);
    expect(rows[0]!.te).toBe(T0 + 120_000);
  });

  it('keeps separate rows per bucket, model, fast mode, session and source', () => {
    const rows = rollupEntries([
      entry(),
      entry({ t: T0 + ROLLUP_BUCKET_MS }),
      entry({ m: 'claude-opus-4-7' }),
      entry({ f: 1 }),
      entry({ s: 'sess-2' }),
      entry({ src: 'codex', m: 'gpt-5.4' }),
    ]);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });

  it('prices each request before summing, so a bucket never crosses the tier', () => {
    // Sonnet 4.5 charges double above 200k input tokens *per request*. Two
    // 150k requests stay under it; their summed 300k would not.
    const rows = rollupEntries([
      entry({ m: 'claude-sonnet-4-5', i: 150_000, o: 0, cc: 0, cr: 0, t: T0 }),
      entry({ m: 'claude-sonnet-4-5', i: 150_000, o: 0, cc: 0, cr: 0, t: T0 + 60_000 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ci).toBeCloseTo(2 * ((150_000 * 3) / 1_000_000), 9);
  });

  it('applies the fast multiplier per request', () => {
    const [slow] = rollupEntries([entry({ m: 'claude-opus-4-7', i: 1000, o: 0, cc: 0, cr: 0 })]);
    const [fast] = rollupEntries([
      entry({ m: 'claude-opus-4-7', i: 1000, o: 0, cc: 0, cr: 0, f: 1 }),
    ]);
    expect(fast!.ci).toBeCloseTo(slow!.ci * 6, 9);
  });

  it('carries a provider-supplied cost through untouched', () => {
    const rows = rollupEntries([
      entry({ src: 'opencode', ci: 0.25, co: 0.5, cwc: 0, crc: 0 }),
      entry({ src: 'opencode', ci: 0.25, co: 0.5, cwc: 0, crc: 0, t: T0 + 60_000 }),
    ]);
    expect(rows[0]!.ci).toBeCloseTo(0.5, 9);
    expect(rows[0]!.co).toBeCloseTo(1, 9);
  });

  it('returns rows sorted by first request', () => {
    const rows = rollupEntries([
      entry({ t: T0 + 3 * ROLLUP_BUCKET_MS }),
      entry({ t: T0 }),
      entry({ t: T0 + ROLLUP_BUCKET_MS }),
    ]);
    expect(rows.map((r) => r.t)).toEqual([T0, T0 + ROLLUP_BUCKET_MS, T0 + 3 * ROLLUP_BUCKET_MS]);
  });

  it('never splits a local-time hour — buckets divide evenly into one', () => {
    expect(3_600_000 % ROLLUP_BUCKET_MS).toBe(0);
  });

  it('handles an empty scan', () => {
    expect(rollupEntries([])).toEqual([]);
  });
});
