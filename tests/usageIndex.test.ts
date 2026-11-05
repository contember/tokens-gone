import { describe, expect, it } from 'bun:test';
import { ROLLUP_BUCKET_MS, rollupEntries } from '../server/rollup';
import type { Entry, UsageRow } from '../server/types';
import { UsageIndex } from '../server/usageIndex';

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

function byTime(list: Entry[]): Entry[] {
  return [...list].sort((a, b) => a.t - b.t);
}

function canonicalRows(rows: UsageRow[]): string[] {
  return rows.map((r) => JSON.stringify(r)).sort();
}

/** The index must always match a from-scratch rollup of everything. */
function expectMatchesFullRollup(index: UsageIndex, lists: Map<string, Entry[]>): void {
  const all = byTime([...lists.values()].flat());
  expect(canonicalRows(index.rows)).toEqual(canonicalRows(rollupEntries(all)));
  expect(index.size).toBe(all.length);
  for (const session of index.sessions()) {
    expect(session.costs.length).toBe(session.entries.length);
    const expected = new Float64Array(session.entries.length);
    rollupEntries(session.entries, expected);
    expect([...session.costs]).toEqual([...expected]);
  }
}

describe('UsageIndex', () => {
  it('folds added, removed and replaced entries into the touched sessions only', () => {
    const a1 = entry({ s: 'A', t: T0 });
    const a2 = entry({ s: 'A', t: T0 + 60_000, o: 10 });
    const b1 = entry({ s: 'B', t: T0 + 30_000, src: 'codex' });
    const index = new UsageIndex();
    let lists = new Map([['cc', [a1, a2]], ['codex', [b1]]]);
    index.update(lists);
    expectMatchesFullRollup(index, lists);
    const sessionB = index.session('B');

    // A larger streaming chunk replaces a2; a new call lands in a new session.
    const a2Final = entry({ s: 'A', t: T0 + 60_000, o: 900 });
    const c1 = entry({ s: 'C', t: T0 + 10 * ROLLUP_BUCKET_MS, m: 'claude-opus-4-7' });
    lists = new Map([['cc', [a1, a2Final, c1]], ['codex', [b1]]]);
    index.update(lists);
    expectMatchesFullRollup(index, lists);
    expect(index.session('B')).toBe(sessionB!);

    // Entries removed entirely, and a provider that disappears.
    lists = new Map([['cc', [a2Final]]]);
    index.update(lists);
    expectMatchesFullRollup(index, lists);
    expect(index.session('B')).toBeUndefined();
    expect(index.session('C')).toBeUndefined();
  });

  it('treats a reordered group of equal timestamps as unchanged', () => {
    const x = entry({ s: 'A', t: T0 });
    const y = entry({ s: 'A', t: T0, o: 7 });
    const index = new UsageIndex();
    index.update(new Map([['cc', [x, y]]]));
    const session = index.session('A');
    index.update(new Map([['cc', [y, x]]]));
    expect(index.session('A')).toBe(session!);
  });

  it('rebuilds when a provider list is not sorted by time', () => {
    const early = entry({ s: 'A', t: T0 });
    const late = entry({ s: 'B', t: T0 + ROLLUP_BUCKET_MS });
    const index = new UsageIndex();
    index.update(new Map([['cc', [early]]]));
    const lists = new Map([['cc', [late, early, entry({ s: 'C', t: T0 - 1 })]]]);
    index.update(lists);
    expectMatchesFullRollup(index, lists);
  });

  it('returns recent entries sorted by time', () => {
    const index = new UsageIndex();
    index.update(new Map([
      ['cc', [entry({ s: 'A', t: T0 }), entry({ s: 'A', t: T0 + 3 })]],
      ['codex', [entry({ s: 'B', t: T0 + 1 }), entry({ s: 'B', t: T0 + 2 })]],
    ]));
    expect(index.entriesSince(T0 + 1).map((e) => e.t)).toEqual([T0 + 1, T0 + 2, T0 + 3]);
  });
});
