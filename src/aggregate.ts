/**
 * Pure functions that filter and aggregate entries. The SPA recomputes
 * these on every render under realistic dataset sizes (~100k entries),
 * so they must be allocation-light: avoid Array.filter/map chains, prefer
 * single-pass for-loops, and reuse the input shape where possible.
 */

import type { Entry, Filters } from './types.ts';
import { costForEntry } from './pricing.ts';

export type Totals = {
  count: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  cost: number;
};

export function emptyTotals(): Totals {
  return {
    count: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    total: 0,
    cost: 0,
  };
}

function addEntry(t: Totals, e: Entry): void {
  t.count++;
  t.input += e.i;
  t.output += e.o;
  t.cacheWrite += e.cc;
  t.cacheRead += e.cr;
  t.total += e.i + e.o + e.cc + e.cr;
  t.cost += costForEntry(e);
}

export function matches(e: Entry, f: Filters): boolean {
  if (f.from !== null && e.t < f.from) return false;
  if (f.to !== null && e.t >= f.to) return false;
  if (f.projects.size > 0 && !f.projects.has(e.p)) return false;
  if (f.models.size > 0 && !f.models.has(e.m)) return false;
  return true;
}

export function applyFilters(entries: Entry[], f: Filters): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (matches(e, f)) out.push(e);
  }
  return out;
}

export function totals(entries: Entry[]): Totals {
  const t = emptyTotals();
  for (let i = 0; i < entries.length; i++) addEntry(t, entries[i]!);
  return t;
}

/**
 * Group by an arbitrary key, returning a sorted array (descending by cost).
 * The generic shape avoids a dozen near-identical helpers.
 */
export function groupBy(
  entries: Entry[],
  keyFn: (e: Entry) => string,
): { key: string; totals: Totals }[] {
  const map = new Map<string, Totals>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const k = keyFn(e);
    let t = map.get(k);
    if (!t) {
      t = emptyTotals();
      map.set(k, t);
    }
    addEntry(t, e);
  }
  const out: { key: string; totals: Totals }[] = [];
  map.forEach((totals, key) => out.push({ key, totals }));
  out.sort((a, b) => b.totals.cost - a.totals.cost);
  return out;
}

/** Day key in local time, YYYY-MM-DD. */
export function dayKey(t: number): string {
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Month key in local time, YYYY-MM. */
export function monthKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Local-time hour bucket, returned as the bucket start in ms. */
export function hourBucket(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** Local-time week bucket (Monday start), returned as the bucket start in ms. */
export function weekBucket(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export type SessionInfo = {
  s: string;
  project: string;
  firstSeen: number;
  lastSeen: number;
  totals: Totals;
  models: string[];
};

/**
 * Sessions are aggregated separately because we want some non-totals
 * fields (first/last seen, model list).
 */
export function sessions(entries: Entry[]): SessionInfo[] {
  const map = new Map<string, SessionInfo>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    let s = map.get(e.s);
    if (!s) {
      s = {
        s: e.s,
        project: e.p,
        firstSeen: e.t,
        lastSeen: e.t,
        totals: emptyTotals(),
        models: [],
      };
      map.set(e.s, s);
    }
    if (e.t < s.firstSeen) s.firstSeen = e.t;
    if (e.t > s.lastSeen) s.lastSeen = e.t;
    if (!s.models.includes(e.m)) s.models.push(e.m);
    addEntry(s.totals, e);
  }
  const out: SessionInfo[] = [];
  map.forEach((v) => out.push(v));
  out.sort((a, b) => b.lastSeen - a.lastSeen);
  return out;
}
