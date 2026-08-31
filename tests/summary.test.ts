import { describe, expect, it } from 'bun:test';
import { createStyle } from '../server/ansi';
import { modelLabel, renderUsageSummary, summarizeUsage } from '../server/summary';
import type { Entry } from '../server/types';

// Local noon, so startOfLocalDay(NOW) is unambiguous regardless of TZ.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const DAY = 86_400_000;

function entry(over: Partial<Entry> = {}): Entry {
  return {
    t: NOW - 1000,
    p: 'foo',
    s: 'sess-1',
    m: 'claude-opus-4-7',
    i: 1000,
    o: 1000,
    cc: 0,
    cr: 0,
    f: 0,
    ...over,
  };
}

describe('modelLabel', () => {
  it('strips claude prefix and date suffix, dotting the version', () => {
    expect(modelLabel('claude-opus-4-7')).toBe('opus-4.7');
    expect(modelLabel('claude-opus-4-7-20260416')).toBe('opus-4.7');
    expect(modelLabel('anthropic/claude-sonnet-4-6')).toBe('sonnet-4.6');
    expect(modelLabel('us.anthropic.claude-opus-4-7')).toBe('opus-4.7');
  });

  it('leaves already-dotted ids alone', () => {
    expect(modelLabel('gpt-5.2-codex')).toBe('gpt-5.2-codex');
    expect(modelLabel('gpt-5')).toBe('gpt-5');
  });
});

describe('summarizeUsage', () => {
  it('buckets entries into the right windows by age', () => {
    const startToday = new Date(2026, 5, 15, 0, 0, 0).getTime();
    const entries: Entry[] = [
      entry({ t: NOW - 40 * DAY }), //       outside 30d
      entry({ t: NOW - 20 * DAY }), //       in 30d only
      entry({ t: NOW - 3 * DAY }), //        in 30d + 7d
      entry({ t: startToday - 5 * 3600_000 }), // yesterday evening → 30d + 7d + yesterday
      entry({ t: NOW - 2000 }), //           today → 30d + 7d + today
    ].sort((a, b) => a.t - b.t);

    const s = summarizeUsage(entries, NOW);
    expect(s.today.reqs).toBe(1);
    expect(s.yesterday.reqs).toBe(1);
    expect(s['7d'].reqs).toBe(3);
    expect(s['30d'].reqs).toBe(4);
  });

  it('7d/30d are calendar windows, not rolling 168h/720h', () => {
    // NOW is Jun 15 12:00. A rolling window (now - 7*DAY = Jun 8 12:00) would
    // include this entry; the calendar window (startOfDay(now) - 6*DAY =
    // Jun 9 00:00) must exclude it. It should still land in 30d.
    const startToday = new Date(2026, 5, 15, 0, 0, 0).getTime();
    const justBeforeCalendar7 = entry({ t: startToday - 6 * DAY - 6 * 3600_000 }); // Jun 8 18:00
    const s = summarizeUsage([justBeforeCalendar7], NOW);
    expect(s['7d'].reqs).toBe(0);
    expect(s['30d'].reqs).toBe(1);
  });

  it('today and yesterday are disjoint calendar days', () => {
    const startToday = new Date(2026, 5, 15, 0, 0, 0).getTime();
    const entries: Entry[] = [
      entry({ t: startToday + 60_000 }), //  just after local midnight → today
      entry({ t: startToday - 60_000 }), //  just before local midnight → yesterday
    ].sort((a, b) => a.t - b.t);
    const s = summarizeUsage(entries, NOW);
    expect(s.today.reqs).toBe(1);
    expect(s.yesterday.reqs).toBe(1);
  });

  it('ignores stray future timestamps', () => {
    const entries: Entry[] = [entry({ t: NOW + 5 * DAY }), entry({ t: NOW - 1000 })];
    const s = summarizeUsage(entries, NOW);
    expect(s.today.reqs).toBe(1);
    expect(s['30d'].reqs).toBe(1);
  });

  it('sums cost and groups by model label (folding date suffixes)', () => {
    const entries: Entry[] = [
      entry({ m: 'claude-opus-4-7', t: NOW - 1000 }),
      entry({ m: 'claude-opus-4-7-20260416', t: NOW - 2000 }),
      entry({ m: 'claude-sonnet-4-6', t: NOW - 3000 }),
    ];
    const s = summarizeUsage(entries, NOW);
    expect(s.today.byModel).toHaveLength(2); // opus-4.7 folded, sonnet-4.6
    const opus = s.today.byModel.find((m) => m.label === 'opus-4.7');
    expect(opus).toBeDefined();
    expect(opus!.cost).toBeGreaterThan(0);
    // Descending by cost: opus (two entries, pricier) before sonnet.
    expect(s.today.byModel[0]!.label).toBe('opus-4.7');
  });

  it('groups by harness with friendly labels', () => {
    const entries: Entry[] = [
      entry({ t: NOW - 1000 }), // cc (default)
      entry({ t: NOW - 2000, src: 'codex', m: 'gpt-5' }),
      entry({ t: NOW - 3000, src: 'pi', ci: 0.01, co: 0.01 }),
    ];
    const s = summarizeUsage(entries, NOW);
    const labels = s.today.byHarness.map((h) => h.label).sort();
    expect(labels).toEqual(['Claude Code', 'Codex', 'Pi']);
  });
});

describe('renderUsageSummary', () => {
  it('returns empty lines when there is no recent activity', () => {
    const s = summarizeUsage([entry({ t: NOW - 100 * DAY })], NOW);
    expect(renderUsageSummary(s)).toEqual([]);
  });

  it('renders a header, all window rows, and a model breakdown', () => {
    const s = summarizeUsage([entry({ t: NOW - 1000 })], NOW);
    const lines = renderUsageSummary(s);
    expect(lines[0]).toBe('Usage');
    expect(lines.some((l) => l.includes('today'))).toBe(true);
    expect(lines.some((l) => l.includes('yesterday'))).toBe(true);
    expect(lines.some((l) => l.includes('last 7 days'))).toBe(true);
    expect(lines.some((l) => l.includes('last 30 days'))).toBe(true);
    expect(lines.some((l) => l.includes('by model (30d)'))).toBe(true);
  });

  it('styling only adds escapes — the plain layout is unchanged', () => {
    const s = summarizeUsage(
      [entry({ t: NOW - 1000 }), entry({ t: NOW - 2000, src: 'codex', m: 'gpt-5' })],
      NOW,
    );
    const styled = renderUsageSummary(s, createStyle(true));
    const stripped = styled.map((l) => l.replace(/\x1b\[\d+m/g, ''));
    expect(stripped).toEqual(renderUsageSummary(s));
    expect(styled.join('\n')).toContain('\x1b[');
  });

  it('shows the harness breakdown only when more than one harness is active', () => {
    const single = renderUsageSummary(summarizeUsage([entry({ t: NOW - 1000 })], NOW));
    expect(single.some((l) => l.includes('by harness'))).toBe(false);

    const multi = renderUsageSummary(
      summarizeUsage(
        [entry({ t: NOW - 1000 }), entry({ t: NOW - 2000, src: 'codex', m: 'gpt-5' })],
        NOW,
      ),
    );
    expect(multi.some((l) => l.includes('by harness (30d)'))).toBe(true);
  });
});
