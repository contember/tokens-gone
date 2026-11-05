/**
 * Per-session index of every provider's entries with their rollup rows and
 * per-request costs, kept up to date incrementally between scans.
 *
 * Providers return their full entry list on every scan, sorted by time, and
 * reuse the same entry objects for data that did not change. An entry is
 * never mutated after it is returned (a changed entry is a new object), so
 * diffing the new list against the previous one by identity yields exactly
 * the added and removed entries. Only the sessions they touch are rolled up
 * again; a list that is not sorted falls back to a full rebuild.
 */

import { rollupEntries } from './rollup.ts';
import type { Entry, UsageRow } from './types.ts';

export type SessionUsage = {
  /** Sorted by time. */
  entries: Entry[];
  /** Per-request cost, aligned with `entries`. */
  costs: Float64Array;
  rows: UsageRow[];
};

type ListDiff = { added: Entry[]; removed: Entry[] };

function isSorted(list: Entry[]): boolean {
  for (let k = 1; k < list.length; k++) {
    if (list[k]!.t < list[k - 1]!.t) return false;
  }
  return true;
}

/**
 * Identity diff of two time-sorted lists. Entries with the same timestamp
 * may come back in another order, so each such group is compared as a set.
 * Returns undefined when `next` is not sorted.
 */
function diffSorted(previous: Entry[], next: Entry[]): ListDiff | undefined {
  const added: Entry[] = [];
  const removed: Entry[] = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < next.length) {
    const a = previous[i]!;
    const b = next[j]!;
    if (j > 0 && b.t < next[j - 1]!.t) return undefined;
    if (a === b) {
      i++;
      j++;
    } else if (a.t < b.t) {
      removed.push(a);
      i++;
    } else if (b.t < a.t) {
      added.push(b);
      j++;
    } else {
      const t = a.t;
      let iEnd = i;
      while (iEnd < previous.length && previous[iEnd]!.t === t) iEnd++;
      let jEnd = j;
      while (jEnd < next.length && next[jEnd]!.t === t) jEnd++;
      const before = new Set(previous.slice(i, iEnd));
      const after = new Set(next.slice(j, jEnd));
      for (const e of after) if (!before.has(e)) added.push(e);
      for (const e of before) if (!after.has(e)) removed.push(e);
      i = iEnd;
      j = jEnd;
    }
  }
  while (i < previous.length) removed.push(previous[i++]!);
  const rest = next.slice(j);
  if (!isSorted(rest) || (j > 0 && rest.length > 0 && rest[0]!.t < next[j - 1]!.t)) return undefined;
  for (const e of rest) added.push(e);
  return { added, removed };
}

function byTime(a: Entry, b: Entry): number {
  return a.t - b.t;
}

function rollupSession(entries: Entry[]): SessionUsage {
  const costs = new Float64Array(entries.length);
  const rows = rollupEntries(entries, costs);
  return { entries, costs, rows };
}

export class UsageIndex {
  private readonly lists = new Map<string, Entry[]>();
  private sessionsById = new Map<string, SessionUsage>();
  private allRows: UsageRow[] = [];
  private entryCount = 0;

  /** Replace the entry lists, keyed by provider; providers left out are removed. */
  update(lists: Map<string, Entry[]>): void {
    const diffs: ListDiff[] = [];
    let rebuild = this.lists.size === 0;
    for (const [key, next] of lists) {
      if (rebuild) break;
      const previous = this.lists.get(key) ?? [];
      const diff = previous === next ? { added: [], removed: [] } : diffSorted(previous, next);
      if (!diff) rebuild = true;
      else diffs.push(diff);
    }
    if (!rebuild) {
      for (const [key, previous] of this.lists) {
        if (!lists.has(key)) diffs.push({ added: [], removed: previous });
      }
    }

    this.lists.clear();
    for (const [key, list] of lists) this.lists.set(key, list);

    if (rebuild) {
      this.rebuild();
      return;
    }
    const touched = new Map<string, { added: Entry[]; removed: Set<Entry> }>();
    const changeFor = (sessionId: string) => {
      let change = touched.get(sessionId);
      if (!change) {
        change = { added: [], removed: new Set() };
        touched.set(sessionId, change);
      }
      return change;
    };
    for (const { added, removed } of diffs) {
      for (const e of added) changeFor(e.s).added.push(e);
      for (const e of removed) changeFor(e.s).removed.add(e);
    }
    if (touched.size === 0) return;

    for (const [sessionId, change] of touched) {
      const current = this.sessionsById.get(sessionId)?.entries ?? [];
      const entries = change.removed.size > 0
        ? current.filter((e) => !change.removed.has(e))
        : current.slice();
      for (const e of change.added) entries.push(e);
      this.entryCount += entries.length - current.length;
      if (entries.length === 0) {
        this.sessionsById.delete(sessionId);
        continue;
      }
      entries.sort(byTime);
      this.sessionsById.set(sessionId, rollupSession(entries));
    }
    this.collectRows();
  }

  private rebuild(): void {
    const bySession = new Map<string, Entry[]>();
    let count = 0;
    for (const list of this.lists.values()) {
      for (const e of list) {
        let entries = bySession.get(e.s);
        if (!entries) {
          entries = [];
          bySession.set(e.s, entries);
        }
        entries.push(e);
        count++;
      }
    }
    this.sessionsById = new Map();
    for (const [sessionId, entries] of bySession) {
      entries.sort(byTime);
      this.sessionsById.set(sessionId, rollupSession(entries));
    }
    this.entryCount = count;
    this.collectRows();
  }

  private collectRows(): void {
    const rows: UsageRow[] = [];
    for (const session of this.sessionsById.values()) {
      for (const row of session.rows) rows.push(row);
    }
    rows.sort((a, b) => a.t - b.t);
    this.allRows = rows;
  }

  /** What `/api/data` ships, sorted by time. */
  get rows(): UsageRow[] {
    return this.allRows;
  }

  get size(): number {
    return this.entryCount;
  }

  session(sessionId: string): SessionUsage | undefined {
    return this.sessionsById.get(sessionId);
  }

  sessions(): IterableIterator<SessionUsage> {
    return this.sessionsById.values();
  }

  /** Entries at or after `fromMs`, sorted by time. */
  entriesSince(fromMs: number): Entry[] {
    const out: Entry[] = [];
    for (const { entries } of this.sessionsById.values()) {
      for (let k = entries.length - 1; k >= 0 && entries[k]!.t >= fromMs; k--) out.push(entries[k]!);
    }
    return out.sort(byTime);
  }
}
