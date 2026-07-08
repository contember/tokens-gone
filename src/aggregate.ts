/**
 * Pure functions that filter and aggregate entries. The SPA recomputes
 * these on every render under realistic dataset sizes (~100k entries),
 * so they must be allocation-light: avoid Array.filter/map chains, prefer
 * single-pass for-loops, and reuse the input shape where possible.
 */

import type { Entry, Filters, PromptDay, SessionMeta } from './types.ts';
import { entryHarness } from './types.ts';
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
  if (f.harnesses.size > 0 && !f.harnesses.has(entryHarness(e))) return false;
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

/*
 * Bucket helpers below are called per-entry in hot loops (~145k times on
 * real datasets). Naive implementations allocate a Date and run several
 * methods per call → 60-80ms per loop. Each function caches its result by
 * a fast integer key (epoch-day or epoch-hour), bringing the second-and-
 * later calls down to a Map lookup.
 *
 * The caches grow at most O(buckets in dataset), which is bounded (≤365
 * days/year, ≤24×365 hours/year, etc.) — no memory concern.
 */

const _tzOffsetMs = new Date().getTimezoneOffset() * -60000;

const _dayKeyCache = new Map<number, string>();
/** Day key in local time, YYYY-MM-DD. */
export function dayKey(t: number): string {
  // Fast bucket index: epoch days, shifted to local time so 00:00–23:59
  // local lands in the same integer.
  const idx = Math.floor((t + _tzOffsetMs) / 86400000);
  const cached = _dayKeyCache.get(idx);
  if (cached !== undefined) return cached;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const s = `${y}-${m}-${day}`;
  _dayKeyCache.set(idx, s);
  return s;
}

const _monthKeyCache = new Map<number, string>();
/** Month key in local time, YYYY-MM. */
export function monthKey(t: number): string {
  // Month index doesn't have a cheap integer form (months are uneven), so
  // we approximate via day-index / 28 to get a key that *might* collide
  // adjacent months — we then trust the cached string was correct.
  // Actually safer: use a Date once, then cache by year*12 + month.
  const d = new Date(t);
  const idx = d.getFullYear() * 12 + d.getMonth();
  const cached = _monthKeyCache.get(idx);
  if (cached !== undefined) return cached;
  const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  _monthKeyCache.set(idx, s);
  return s;
}

const _hourBucketCache = new Map<number, number>();
/** Local-time hour bucket, returned as the bucket start in ms. */
export function hourBucket(t: number): number {
  const idx = Math.floor((t + _tzOffsetMs) / 3600000);
  const cached = _hourBucketCache.get(idx);
  if (cached !== undefined) return cached;
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  const ms = d.getTime();
  _hourBucketCache.set(idx, ms);
  return ms;
}

const _weekBucketCache = new Map<number, number>();
/** Local-time week bucket (Monday start), returned as the bucket start in ms. */
export function weekBucket(t: number): number {
  // Same idea: per-day index → cached week-start ms. Avoids re-running
  // setHours + getDay + setDate on every entry of the same day.
  const dayIdx = Math.floor((t + _tzOffsetMs) / 86400000);
  const cached = _weekBucketCache.get(dayIdx);
  if (cached !== undefined) return cached;
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  const ms = d.getTime();
  _weekBucketCache.set(dayIdx, ms);
  return ms;
}

/**
 * Unified shape consumed by the activity heatmap. Both the cost-based
 * timeline (from session entries) and the prompt-based timeline (from
 * `history.jsonl`) project onto this so the heatmap renders one way.
 */
export type HeatmapDay = {
  date: string;
  ms: number;
  /** Drives cell intensity (cost in $ or prompt count, depending on mode). */
  value: number;
  /** Raw request/prompt count for the day — always shown in tooltip. */
  count: number;
  /** Top-N breakdown for the tooltip. Keys are model IDs in cost mode and
   * project names in prompts mode. */
  breakdown: Map<string, number>;
  /** True in cost mode when prompts exist for this day but session JSONLs
   * were swept — cell is a known data hole, not a true zero. */
  missing?: boolean;
  /** Estimated cost for a missing day, derived from prompt-to-cost rates
   * on days where both signals are intact. */
  estimatedCost?: number;
};

export function dayStatsToHeatmap(
  days: DayStat[],
  missing?: Map<string, { prompts: number; estimatedCost: number }>,
): HeatmapDay[] {
  return days.map((d) => {
    const m = missing?.get(d.date);
    if (m && d.cost === 0 && m.prompts > 0) {
      return {
        date: d.date,
        ms: d.ms,
        value: 0,
        count: m.prompts,
        breakdown: d.byModel,
        missing: true,
        estimatedCost: m.estimatedCost,
      };
    }
    return {
      date: d.date,
      ms: d.ms,
      value: d.cost,
      count: d.count,
      breakdown: d.byModel,
    };
  });
}

export type MissingActivity = {
  /** Days where at least one prompt's session has no entries. */
  affectedDays: number;
  /** Subset of `affectedDays`: days where every prompt is orphan (the
   * heatmap hatches these — the day is a full data hole). */
  fullyMissingDays: number;
  /** Sum of orphan prompts across `affectedDays`. */
  missingPrompts: number;
  /** Cost reconstructed from per-project prompt-to-cost rates, summed
   * across all orphan prompts. Rough — it assumes a missing day's mix of
   * work matches the user's observed mix on intact days. */
  estimatedCost: number;
  /** Per-date detail so the heatmap can mark and label individual cells. */
  byDate: Map<string, { prompts: number; estimatedCost: number }>;
};

/**
 * Reconstruct a rough cost for days where `history.jsonl` recorded
 * prompts but their session JSONLs were swept by `cleanupPeriodDays`.
 *
 * "Missing" is decided per-prompt by sessionId — if a prompt's session
 * has any entries in our scan (even on a different day), the session is
 * intact and that prompt is *not* counted as lost. This avoids false
 * positives when a session spans midnight (prompt logged at 23:55, API
 * response at 00:05) or a `/resume` brings an old session forward.
 *
 * For the cost projection, we compute a per-project cost-per-prompt rate
 * from days where both signals are intact, then scale each missing day's
 * orphan prompts by the day's own project mix. A project with too few
 * sample points falls back to a global rate.
 *
 * This is a best-effort estimate, not an accounting figure — the user's
 * prompt mix varies day to day, and rare expensive prompts can skew rates.
 * We bias toward "rough and labeled as such" over "precise and silent".
 */
export function estimateMissingActivity(
  entries: Entry[],
  promptDays: PromptDay[],
  fromMs: number,
  toMs: number,
): MissingActivity {
  const fromDay = startOfDay(fromMs);
  const toDay = startOfDay(toMs - 1);

  // (date, project) → cost from session entries.
  const costByDateProject = new Map<string, number>();
  // (date) → total cost (used to compute per-day rates).
  const costByDate = new Map<string, number>();
  // Every sessionId we have *any* entries for — a session anywhere in the
  // entries log is considered intact for the purposes of orphan detection.
  const knownSessions = new Set<string>();
  for (const e of entries) {
    if (e.s) knownSessions.add(e.s);
    if (e.t < fromDay || e.t >= toDay + 86400000) continue;
    const date = dayKey(e.t);
    const c = costForEntry(e);
    if (c === 0) continue;
    const k = `${date}|${e.p}`;
    costByDateProject.set(k, (costByDateProject.get(k) ?? 0) + c);
    costByDate.set(date, (costByDate.get(date) ?? 0) + c);
  }

  // Sample per-project rates from days where both signals are intact.
  const projectStats = new Map<string, { cost: number; prompts: number }>();
  let globalCost = 0;
  let globalPrompts = 0;
  for (const pd of promptDays) {
    if (pd.ms < fromDay || pd.ms > toDay) continue;
    if (!costByDate.has(pd.date)) continue;
    for (const [project, count] of Object.entries(pd.byProject)) {
      const cost = costByDateProject.get(`${pd.date}|${project}`);
      if (cost == null) continue;
      let s = projectStats.get(project);
      if (!s) {
        s = { cost: 0, prompts: 0 };
        projectStats.set(project, s);
      }
      s.cost += cost;
      s.prompts += count;
      globalCost += cost;
      globalPrompts += count;
    }
  }

  const globalRate = globalPrompts > 0 ? globalCost / globalPrompts : 0;
  // Need a few sample prompts per project before trusting its rate;
  // otherwise a one-off cheap day overfits and lowballs the estimate.
  const MIN_PROMPTS_FOR_PROJECT_RATE = 20;
  function rateFor(project: string): number {
    const s = projectStats.get(project);
    if (s && s.prompts >= MIN_PROMPTS_FOR_PROJECT_RATE && s.cost > 0) {
      return s.cost / s.prompts;
    }
    return globalRate;
  }

  // Score missing days. A day's "orphan prompts" are the ones whose
  // sessionId is *not* in `knownSessions` — those are the genuinely lost
  // ones. We then scale the day's project mix by the orphan share to
  // estimate cost.
  let affectedDays = 0;
  let fullyMissingDays = 0;
  let missingPrompts = 0;
  let estimatedCost = 0;
  const byDate = new Map<string, { prompts: number; estimatedCost: number }>();
  for (const pd of promptDays) {
    if (pd.ms < fromDay || pd.ms > toDay) continue;
    if (pd.count === 0) continue;

    let orphan = 0;
    for (const [sessionId, count] of Object.entries(pd.bySession)) {
      if (!knownSessions.has(sessionId)) orphan += count;
    }
    if (orphan === 0) continue;

    // Distribute orphan prompts across the day's projects in the same
    // proportion as the total prompts. (We don't track per-session →
    // project mapping on the wire, but per session Claude Code only logs
    // one cwd, so the day's project mix is a fair stand-in.)
    const total = pd.count;
    let est = 0;
    for (const [project, count] of Object.entries(pd.byProject)) {
      const orphanInProject = (count / total) * orphan;
      est += orphanInProject * rateFor(project);
    }
    affectedDays++;
    if (!costByDate.has(pd.date)) fullyMissingDays++;
    missingPrompts += orphan;
    estimatedCost += est;
    byDate.set(pd.date, { prompts: orphan, estimatedCost: est });
  }

  return { affectedDays, fullyMissingDays, missingPrompts, estimatedCost, byDate };
}

/**
 * Densify a sparse `PromptDay[]` into a `HeatmapDay[]` covering [from, to).
 * Mirrors `daily()`'s densification so the heatmap can render empty cells
 * for days with no prompts.
 */
export function promptDaysToHeatmap(
  prompts: Array<{ date: string; ms: number; count: number; byProject: Record<string, number> }>,
  from: number,
  to: number,
  projectFilter?: Set<string>,
): HeatmapDay[] {
  const map = new Map<string, HeatmapDay>();
  for (const p of prompts) {
    let count = p.count;
    let byProject = p.byProject;
    if (projectFilter && projectFilter.size > 0) {
      let filteredCount = 0;
      const filtered: Record<string, number> = {};
      for (const [proj, c] of Object.entries(p.byProject)) {
        if (projectFilter.has(proj)) {
          filtered[proj] = c;
          filteredCount += c;
        }
      }
      if (filteredCount === 0) continue;
      count = filteredCount;
      byProject = filtered;
    }
    map.set(p.date, {
      date: p.date,
      ms: p.ms,
      value: count,
      count,
      breakdown: new Map(Object.entries(byProject)),
    });
  }
  const out: HeatmapDay[] = [];
  for (let d = startOfDay(from); d <= startOfDay(to - 1); d += 86400000) {
    const k = isoDateFromMs(d);
    out.push(
      map.get(k) ?? {
        date: k,
        ms: d,
        value: 0,
        count: 0,
        breakdown: new Map(),
      },
    );
  }
  return out;
}

export type DayStat = {
  /** Local-time YYYY-MM-DD. */
  date: string;
  /** ms since epoch at local midnight (sort/filter key). */
  ms: number;
  cost: number;
  count: number;
  total: number;
  /** Per-model cost split — populated for tooltip drill-down. */
  byModel: Map<string, number>;
};

/**
 * Build a per-day timeline of cost + request counts over the entries.
 * Output is dense — days with zero activity are included so the heatmap
 * has empty cells in their proper spots.
 */
export function daily(entries: Entry[], from?: number, to?: number): DayStat[] {
  if (entries.length === 0) return [];
  const map = new Map<string, DayStat>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const k = dayKey(e.t);
    let d = map.get(k);
    if (!d) {
      const dt = new Date(e.t);
      dt.setHours(0, 0, 0, 0);
      d = {
        date: k,
        ms: dt.getTime(),
        cost: 0,
        count: 0,
        total: 0,
        byModel: new Map(),
      };
      map.set(k, d);
    }
    const c = costForEntry(e);
    d.cost += c;
    d.count++;
    d.total += e.i + e.o + e.cc + e.cr;
    d.byModel.set(e.m, (d.byModel.get(e.m) ?? 0) + c);
  }

  // Densify so the heatmap can render zero-cost cells. Range covers either
  // the explicit [from, to] window or the data's own extent.
  const sorted = [...map.values()].sort((a, b) => a.ms - b.ms);
  if (sorted.length === 0) return [];
  const first = from != null ? startOfDay(from) : sorted[0]!.ms;
  const last = to != null ? startOfDay(to - 1) : sorted[sorted.length - 1]!.ms;
  const out: DayStat[] = [];
  for (let d = first; d <= last; d += 86400000) {
    const k = isoDateFromMs(d);
    out.push(
      map.get(k) ?? {
        date: k,
        ms: d,
        cost: 0,
        count: 0,
        total: 0,
        byModel: new Map(),
      },
    );
  }
  return out;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoDateFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type ActivityStats = {
  activeDays: number;
  totalDays: number;
  currentStreak: number;
  longestStreak: number;
  mostActiveDay: { date: string; cost: number } | null;
};

/**
 * Compute streak-style stats from a densified day series. Streak rules
 * match Claude's: consecutive active days count, today doesn't break the
 * current streak just because it's incomplete.
 */
export function activityStats(days: DayStat[]): ActivityStats {
  if (days.length === 0) {
    return {
      activeDays: 0,
      totalDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      mostActiveDay: null,
    };
  }
  let activeDays = 0;
  let longestStreak = 0;
  let runningStreak = 0;
  let currentStreak = 0;
  let mostActive: DayStat | null = null;

  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    const active = d.count > 0;
    if (active) {
      activeDays++;
      runningStreak++;
      if (runningStreak > longestStreak) longestStreak = runningStreak;
    } else {
      runningStreak = 0;
    }
    if (!mostActive || d.cost > mostActive.cost) mostActive = d;
  }

  // Current streak: walk back from the most recent day. Today with 0 cost
  // is "not yet active" not "broken" — so we skip it.
  const today = startOfDay(Date.now());
  let i = days.length - 1;
  if (days[i] && days[i]!.ms === today && days[i]!.count === 0) i--;
  while (i >= 0 && days[i]!.count > 0) {
    currentStreak++;
    i--;
  }

  return {
    activeDays,
    totalDays: days.length,
    currentStreak,
    longestStreak,
    mostActiveDay: mostActive && mostActive.cost > 0
      ? { date: mostActive.date, cost: mostActive.cost }
      : null,
  };
}

/**
 * 24-bucket distribution of cost by hour of local day. Useful for showing
 * "when do you actually work" — Claude's own activity report excludes this.
 */
export function hourlyDistribution(entries: Entry[]): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const h = new Date(e.t).getHours();
    buckets[h]! += costForEntry(e);
  }
  return buckets;
}

/** Most recent activity timestamp across entries (for burn-rate calc). */
export function recentBurn(entries: Entry[], windowMs = 60 * 60 * 1000): {
  cost: number;
  reqs: number;
  perHour: number;
} {
  if (entries.length === 0) return { cost: 0, reqs: 0, perHour: 0 };
  // Entries are sorted ascending by t.
  const last = entries[entries.length - 1]!.t;
  const cutoff = last - windowMs;
  let cost = 0;
  let reqs = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.t < cutoff) break;
    cost += costForEntry(e);
    reqs++;
  }
  return { cost, reqs, perHour: cost * (3600_000 / windowMs) };
}

export type SessionInfo = {
  s: string;
  src?: Entry['src'];
  project: string;
  firstSeen: number;
  lastSeen: number;
  totals: Totals;
  models: string[];
  /** Title from Claude's sessions-index.json, if available. */
  title?: string;
  /** First user prompt — fallback label when no summary exists yet. */
  firstPrompt?: string;
  parentSessionId?: string;
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
};

/**
 * Sessions are aggregated separately because we want some non-totals
 * fields (first/last seen, model list).
 */
export function sessions(
  entries: Entry[],
  meta: Record<string, SessionMeta> = {},
): SessionInfo[] {
  const map = new Map<string, SessionInfo>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    let s = map.get(e.s);
    if (!s) {
      const m = meta[e.s];
      s = {
        s: e.s,
        src: e.src,
        project: e.p,
        firstSeen: e.t,
        lastSeen: e.t,
        totals: emptyTotals(),
        models: [],
        title: m?.summary,
        firstPrompt: m?.firstPrompt,
        parentSessionId: m?.parentSessionId,
        threadSource: m?.threadSource,
        agentNickname: m?.agentNickname,
        agentRole: m?.agentRole,
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
