import { describe, expect, it } from 'bun:test';
import {
  applyFilters,
  dayKey,
  estimateMissingActivity,
  groupBy,
  hourBucket,
  monthKey,
  sessions,
  totals,
  weekBucket,
} from '../src/aggregate';
import type { Entry, Filters, PromptDay } from '../src/types';

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

const EMPTY: Filters = { from: null, to: null, projects: new Set(), models: new Set(), harnesses: new Set() };

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

  it('applyFilters filters by harness, treating missing src as cc', () => {
    const cc = entry({ s: 'cc-1' }); // no src → cc
    const codex = entry({ s: 'cx-1', src: 'codex' });
    expect(applyFilters([cc, codex], { ...EMPTY, harnesses: new Set(['cc']) }).length).toBe(1);
    expect(applyFilters([cc, codex], { ...EMPTY, harnesses: new Set(['codex']) }).length).toBe(1);
    expect(applyFilters([cc, codex], { ...EMPTY, harnesses: new Set(['cc', 'codex']) }).length).toBe(2);
    expect(applyFilters([cc, codex], EMPTY).length).toBe(2); // empty set = all
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

  describe('estimateMissingActivity', () => {
    // Build a prompt-day shape mirroring the server payload.
    function pd(date: string, byProject: Record<string, number>): PromptDay {
      const d = new Date(date + 'T00:00:00');
      const count = Object.values(byProject).reduce((s, n) => s + n, 0);
      return { date, ms: d.getTime(), count, byProject };
    }

    const t = (iso: string) => Date.parse(iso);

    it('returns zero estimate when no days are missing', () => {
      // A day with both signals → no missing data to reconstruct.
      const e = entry({ t: t('2026-04-15T10:00:00') });
      const prompts: PromptDay[] = [pd('2026-04-15', { foo: 5 })];
      const r = estimateMissingActivity(
        [e],
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-20T00:00:00'),
      );
      expect(r.missingDays).toBe(0);
      expect(r.missingPrompts).toBe(0);
      expect(r.estimatedCost).toBe(0);
    });

    it('estimates lost cost using per-project rate when there are enough samples', () => {
      // Build a project ('foo') with 100 prompts that produced known cost,
      // then a missing day with 50 prompts on the same project. Estimate
      // should equal exactly 50 × per-prompt rate.
      const sampleDate = '2026-04-15';
      // 100 entries of identical cost on the sample day, paired with 100
      // prompts that day → per-prompt rate = entryCost.
      const sampleEntries: Entry[] = [];
      for (let i = 0; i < 100; i++) {
        sampleEntries.push(
          entry({
            t: t(`${sampleDate}T10:${String(i % 60).padStart(2, '0')}:00`),
            s: `sess-${i}`,
            p: 'foo',
          }),
        );
      }
      const onePromptCost =
        sampleEntries.reduce((s, e) => s + 0, 0); // ignore — recompute via fn
      // Use the aggregate's own daily() indirectly via totals to compute
      // expected cost (avoids re-importing the pricing tables).
      const sampleCost = totals(sampleEntries).cost;
      const rate = sampleCost / 100;
      expect(rate).toBeGreaterThan(0);

      const prompts: PromptDay[] = [
        pd(sampleDate, { foo: 100 }),
        // Missing day: prompts exist, no entries
        pd('2026-04-20', { foo: 50 }),
      ];

      const r = estimateMissingActivity(
        sampleEntries,
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-25T00:00:00'),
      );
      expect(r.missingDays).toBe(1);
      expect(r.missingPrompts).toBe(50);
      // 50 prompts × rate, within float tolerance.
      expect(r.estimatedCost).toBeCloseTo(50 * rate, 5);
      expect(r.byDate.get('2026-04-20')?.prompts).toBe(50);
    });

    it('falls back to global rate when a project lacks enough samples', () => {
      // Project 'tiny' has only 3 sample prompts → below MIN_PROMPTS_FOR_PROJECT_RATE.
      // Should fall back to the global rate derived from all sample days.
      const sampleEntries: Entry[] = [];
      for (let i = 0; i < 50; i++) {
        sampleEntries.push(
          entry({
            t: t(`2026-04-15T10:${String(i % 60).padStart(2, '0')}:00`),
            s: `sess-A-${i}`,
            p: 'big',
          }),
        );
      }
      for (let i = 0; i < 3; i++) {
        sampleEntries.push(
          entry({
            t: t(`2026-04-15T12:0${i}:00`),
            s: `sess-B-${i}`,
            p: 'tiny',
          }),
        );
      }
      const prompts: PromptDay[] = [
        pd('2026-04-15', { big: 50, tiny: 3 }),
        pd('2026-04-20', { tiny: 10 }),
      ];

      const r = estimateMissingActivity(
        sampleEntries,
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-25T00:00:00'),
      );
      expect(r.missingDays).toBe(1);
      expect(r.missingPrompts).toBe(10);
      // Estimate should be positive (used global rate, not zeroed out).
      expect(r.estimatedCost).toBeGreaterThan(0);
    });
  });
});
