import { describe, expect, it } from 'bun:test';
import {
  applyFilters,
  dayKey,
  groupBy,
  hourBucket,
  monthKey,
  sessions,
  totals,
  weekBucket,
} from '../src/aggregate';
import type { Entry, Filters } from '../src/types';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    t: Date.parse('2026-04-15T10:00:00Z'),
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

const EMPTY: Filters = { from: null, to: null, projects: new Set(), models: new Set() };

describe('aggregate', () => {
  it('totals sums all token types and counts entries', () => {
    const t = totals([entry({ i: 1, o: 2, cc: 3, cr: 4 }), entry({ i: 10, o: 20, cc: 30, cr: 40 })]);
    expect(t.count).toBe(2);
    expect(t.input).toBe(11);
    expect(t.output).toBe(22);
    expect(t.cacheWrite).toBe(33);
    expect(t.cacheRead).toBe(44);
    expect(t.total).toBe(11 + 22 + 33 + 44);
    expect(t.cost).toBeGreaterThan(0);
  });

  it('applyFilters respects from/to bounds', () => {
    const a = entry({ t: 1000 });
    const b = entry({ t: 2000 });
    const c = entry({ t: 3000 });
    expect(applyFilters([a, b, c], { ...EMPTY, from: 1500, to: null }).length).toBe(2);
    expect(applyFilters([a, b, c], { ...EMPTY, from: null, to: 2500 }).length).toBe(2);
    expect(applyFilters([a, b, c], { ...EMPTY, from: 1500, to: 2500 }).length).toBe(1);
  });

  it('to is exclusive (matches "day starting tomorrow" intuition)', () => {
    const a = entry({ t: 2000 });
    expect(applyFilters([a], { ...EMPTY, from: null, to: 2000 }).length).toBe(0);
    expect(applyFilters([a], { ...EMPTY, from: 2000, to: null }).length).toBe(1);
  });

  it('applyFilters intersects projects and models', () => {
    const a = entry({ p: 'foo', m: 'claude-opus-4-7' });
    const b = entry({ p: 'foo', m: 'claude-sonnet-4-6' });
    const c = entry({ p: 'bar', m: 'claude-opus-4-7' });
    expect(
      applyFilters([a, b, c], {
        ...EMPTY,
        projects: new Set(['foo']),
        models: new Set(['claude-opus-4-7']),
      }).length,
    ).toBe(1);
  });

  it('groupBy sorts by cost descending', () => {
    const cheap = entry({ m: 'claude-haiku-4-5', p: 'a' });
    const pricey = entry({ m: 'claude-opus-4-7', p: 'b' });
    const result = groupBy([cheap, pricey, pricey], (e) => e.p);
    expect(result[0]?.key).toBe('b');
    expect(result[1]?.key).toBe('a');
  });

  it('sessions track first/last seen and unique models', () => {
    const t1 = Date.parse('2026-04-15T10:00:00Z');
    const t2 = Date.parse('2026-04-15T11:00:00Z');
    const t3 = Date.parse('2026-04-15T12:00:00Z');
    const result = sessions([
      entry({ s: 'A', m: 'claude-opus-4-7', t: t2 }),
      entry({ s: 'A', m: 'claude-sonnet-4-6', t: t1 }),
      entry({ s: 'A', m: 'claude-opus-4-7', t: t3 }),
      entry({ s: 'B', t: t1 }),
    ]);
    const a = result.find((s) => s.s === 'A');
    expect(a).toBeDefined();
    expect(a!.firstSeen).toBe(t1);
    expect(a!.lastSeen).toBe(t3);
    expect(a!.totals.count).toBe(3);
    expect(a!.models.length).toBe(2);
  });

  it('dayKey and monthKey are local-time YYYY-MM-DD/YYYY-MM', () => {
    const t = Date.parse('2026-04-15T22:00:00Z');
    expect(dayKey(t)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(monthKey(t)).toMatch(/^\d{4}-\d{2}$/);
  });

  it('hourBucket aligns to local-time hour', () => {
    const t = Date.parse('2026-04-15T10:37:21Z');
    const b = hourBucket(t);
    const d = new Date(b);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it('weekBucket aligns to Monday 00:00 local', () => {
    // 2026-04-15 is a Wednesday → expect Monday 2026-04-13
    const t = Date.parse('2026-04-15T12:00:00');
    const b = weekBucket(t);
    const d = new Date(b);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(0);
  });
});
