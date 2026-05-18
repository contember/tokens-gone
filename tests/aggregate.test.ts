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
    // Build a prompt-day shape mirroring the server payload. `bySession`
    // is required for orphan detection, so callers must supply it.
    function pd(
      date: string,
      byProject: Record<string, number>,
      bySession: Record<string, number>,
    ): PromptDay {
      const d = new Date(date + 'T00:00:00');
      const count = Object.values(byProject).reduce((s, n) => s + n, 0);
      return { date, ms: d.getTime(), count, byProject, bySession };
    }

    const t = (iso: string) => Date.parse(iso);

    it('returns zero estimate when no days are missing', () => {
      const e = entry({ t: t('2026-04-15T10:00:00'), s: 'sess-known' });
      const prompts: PromptDay[] = [
        pd('2026-04-15', { foo: 5 }, { 'sess-known': 5 }),
      ];
      const r = estimateMissingActivity(
        [e],
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-20T00:00:00'),
      );
      expect(r.affectedDays).toBe(0);
      expect(r.missingPrompts).toBe(0);
      expect(r.estimatedCost).toBe(0);
    });

    it('does NOT flag a day as missing when its prompts belong to sessions found elsewhere in entries', () => {
      // Session spans midnight: prompt logged at 23:55 Apr 14, the
      // assistant API call happens at 00:10 Apr 15 — same sessionId.
      const sampleEntries: Entry[] = [
        entry({ t: t('2026-04-15T00:10:00'), s: 'spans-midnight', p: 'foo' }),
      ];
      const prompts: PromptDay[] = [
        // The "missing" day. Its prompt's sessionId is in our entries (just
        // on a different day), so it should not be marked missing.
        pd('2026-04-14', { foo: 1 }, { 'spans-midnight': 1 }),
        // A sibling intact day for rate sampling.
        pd('2026-04-15', { foo: 1 }, { 'spans-midnight': 1 }),
      ];
      const r = estimateMissingActivity(
        sampleEntries,
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-20T00:00:00'),
      );
      expect(r.affectedDays).toBe(0);
      expect(r.missingPrompts).toBe(0);
      expect(r.byDate.has('2026-04-14')).toBe(false);
    });

    it('estimates lost cost only for prompts whose sessionId is not in entries', () => {
      const sampleDate = '2026-04-15';
      const sampleEntries: Entry[] = [];
      for (let i = 0; i < 100; i++) {
        sampleEntries.push(
          entry({
            t: t(`${sampleDate}T10:${String(i % 60).padStart(2, '0')}:00`),
            s: `sess-known-${i}`,
            p: 'foo',
          }),
        );
      }
      const sampleCost = totals(sampleEntries).cost;
      const rate = sampleCost / 100;
      expect(rate).toBeGreaterThan(0);

      const sampleSessions: Record<string, number> = {};
      for (let i = 0; i < 100; i++) sampleSessions[`sess-known-${i}`] = 1;

      const prompts: PromptDay[] = [
        pd(sampleDate, { foo: 100 }, sampleSessions),
        // Missing day: 50 prompts, all on never-seen sessions.
        pd(
          '2026-04-20',
          { foo: 50 },
          Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [`sess-lost-${i}`, 1]),
          ),
        ),
      ];

      const r = estimateMissingActivity(
        sampleEntries,
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-25T00:00:00'),
      );
      expect(r.affectedDays).toBe(1);
      expect(r.missingPrompts).toBe(50);
      expect(r.estimatedCost).toBeCloseTo(50 * rate, 5);
      expect(r.byDate.get('2026-04-20')?.prompts).toBe(50);
    });

    it('counts only orphan prompts on a partially-lost day', () => {
      // Day has 10 prompts: 3 are on a known session (covered) and 7 are
      // on lost sessions → should report 7 missing, not 10.
      const sampleEntries: Entry[] = [
        entry({ t: t('2026-04-15T10:00:00'), s: 'known-A', p: 'foo' }),
        entry({ t: t('2026-04-15T11:00:00'), s: 'known-A', p: 'foo' }),
      ];

      const prompts: PromptDay[] = [
        pd('2026-04-15', { foo: 10 }, { 'known-A': 3, 'lost-X': 7 }),
      ];

      const r = estimateMissingActivity(
        sampleEntries,
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-20T00:00:00'),
      );
      expect(r.affectedDays).toBe(1);
      // The partial day still has cost > 0 from `known-A` entries, so it
      // is NOT one of the "fully wiped" days.
      expect(r.fullyMissingDays).toBe(0);
      expect(r.missingPrompts).toBe(7);
      // Some estimated cost is produced (global rate from the sample day).
      expect(r.estimatedCost).toBeGreaterThan(0);
    });

    it('falls back to global rate when a project lacks enough samples', () => {
      const sampleEntries: Entry[] = [];
      for (let i = 0; i < 50; i++) {
        sampleEntries.push(
          entry({
            t: t(`2026-04-15T10:${String(i % 60).padStart(2, '0')}:00`),
            s: `sess-big-${i}`,
            p: 'big',
          }),
        );
      }
      for (let i = 0; i < 3; i++) {
        sampleEntries.push(
          entry({
            t: t(`2026-04-15T12:0${i}:00`),
            s: `sess-tiny-${i}`,
            p: 'tiny',
          }),
        );
      }
      const sampleBigSessions = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`sess-big-${i}`, 1]),
      );
      const sampleTinySessions = Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`sess-tiny-${i}`, 1]),
      );
      const lostTinySessions = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`sess-tiny-lost-${i}`, 1]),
      );

      const prompts: PromptDay[] = [
        pd(
          '2026-04-15',
          { big: 50, tiny: 3 },
          { ...sampleBigSessions, ...sampleTinySessions },
        ),
        pd('2026-04-20', { tiny: 10 }, lostTinySessions),
      ];

      const r = estimateMissingActivity(
        sampleEntries,
        prompts,
        t('2026-04-10T00:00:00'),
        t('2026-04-25T00:00:00'),
      );
      expect(r.affectedDays).toBe(1);
      expect(r.missingPrompts).toBe(10);
      expect(r.estimatedCost).toBeGreaterThan(0);
    });
  });
});
