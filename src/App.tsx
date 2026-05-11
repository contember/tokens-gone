import { useEffect, useMemo, useState } from 'react';
import type { ApiData, Entry, Filters } from './types';
import {
  activityStats,
  applyFilters,
  daily,
  recentBurn,
  sessions,
  type Totals,
} from './aggregate';
import { costBreakdown } from './pricing';
import { ActiveFilters } from './components/ActiveFilters';
import { ActivityHeatmap } from './components/ActivityHeatmap';
import { BreakdownTable } from './components/BreakdownTable';
import { Hero } from './components/Hero';
import { HourGrid } from './components/HourGrid';
import { SessionDetail } from './components/SessionDetail';
import { SessionTable } from './components/SessionTable';
import type { SessionInfo } from './aggregate';
import { StatStrip } from './components/StatStrip';
import { Timeline } from './components/Timeline';

const EMPTY_FILTERS: Filters = {
  from: null,
  to: null,
  projects: new Set(),
  models: new Set(),
  harnesses: new Set(),
};

export function App() {
  const [data, setData] = useState<ApiData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetch('/api/data')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await fetch('/api/refresh', { method: 'POST' });
      const r = await fetch('/api/data');
      setData(await r.json());
    } catch (e) {
      setErr(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  if (err) return <div className="app"><div className="error">{err}</div></div>;
  if (!data)
    return (
      <div className="app">
        <div className="loading">Reading transcripts…</div>
      </div>
    );

  return (
    <Dashboard
      data={data}
      filters={filters}
      setFilters={setFilters}
      onRefresh={refresh}
      refreshing={refreshing}
    />
  );
}

function Dashboard({
  data,
  filters,
  setFilters,
  onRefresh,
  refreshing,
}: {
  data: ApiData;
  filters: Filters;
  setFilters: (f: Filters) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const filtered = useMemo<Entry[]>(
    () => applyFilters(data.entries, filters),
    [data.entries, filters],
  );

  // Single hot pass over filtered entries: totals + token-type breakdown
  // + per-entry totals + per-key buckets for the breakdown tables. Doing
  // it in one loop costs the same as one Array.filter iteration; doing it
  // across five useMemos used to dominate render time on 100k+ datasets.
  const aggregates = useMemo(() => {
    const t: Totals = {
      count: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0,
    };
    let inputCost = 0, outputCost = 0, cwriteCost = 0, creadCost = 0;
    const byModel = new Map<string, { totals: Totals; entries: Entry[] }>();
    const byProject = new Map<string, { totals: Totals; entries: Entry[] }>();

    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i]!;
      const b = costBreakdown(e);

      t.count++;
      t.input += e.i; t.output += e.o; t.cacheWrite += e.cc; t.cacheRead += e.cr;
      t.total += e.i + e.o + e.cc + e.cr;
      t.cost += b.total;
      inputCost += b.input; outputCost += b.output;
      cwriteCost += b.cwrite; creadCost += b.cread;

      let m = byModel.get(e.m);
      if (!m) {
        m = { totals: emptyTotals(), entries: [] };
        byModel.set(e.m, m);
      }
      addToTotals(m.totals, e, b.total);
      m.entries.push(e);

      let p = byProject.get(e.p);
      if (!p) {
        p = { totals: emptyTotals(), entries: [] };
        byProject.set(e.p, p);
      }
      addToTotals(p.totals, e, b.total);
      p.entries.push(e);
    }

    const byModelRows = [...byModel.entries()]
      .map(([key, v]) => ({ key, totals: v.totals, entries: v.entries }))
      .sort((a, b) => b.totals.cost - a.totals.cost);
    const byProjectRows = [...byProject.entries()]
      .map(([key, v]) => ({ key, totals: v.totals, entries: v.entries }))
      .sort((a, b) => b.totals.cost - a.totals.cost);

    return {
      t,
      costByType: { input: inputCost, output: outputCost, cwrite: cwriteCost, cread: creadCost },
      byModelRows,
      byProjectRows,
    };
  }, [filtered]);
  const t = aggregates.t;
  const costByType = aggregates.costByType;

  // Heatmap always covers a full year ending today. Date filters are
  // ignored (so the heatmap context is preserved when drilling in via a
  // cell click), but model/project filters apply.
  const yearDays = useMemo(() => {
    if (data.entries.length === 0) return [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = todayStart.getTime();
    const from = today - 364 * 86400000;
    const yearEntries = applyFilters(data.entries, {
      from,
      to: null,
      projects: filters.projects,
      models: filters.models,
      harnesses: filters.harnesses,
    });
    return daily(yearEntries, from, today + 86400000);
  }, [data.entries, filters.projects, filters.models, filters.harnesses]);

  const stats = useMemo(() => activityStats(yearDays), [yearDays]);
  const burn = useMemo(() => recentBurn(filtered), [filtered]);

  // Currently-selected single-day filter — used to ring the heatmap cell.
  const selectedDayMs = useMemo<number | null>(() => {
    if (filters.from === null || filters.to === null) return null;
    if (filters.to - filters.from !== 86400000) return null;
    return filters.from;
  }, [filters]);

  function toggleDay(dayMs: number | null) {
    if (dayMs === null) {
      setFilters({ ...filters, from: null, to: null });
    } else {
      setFilters({ ...filters, from: dayMs, to: dayMs + 86400000 });
    }
  }

  function toggleFilter(key: 'projects' | 'models', value: string) {
    const next = new Set(filters[key]);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setFilters({ ...filters, [key]: next });
  }

  const byModelRows = aggregates.byModelRows;
  const byProjectRows = aggregates.byProjectRows;
  const sess = useMemo(() => sessions(filtered, data.sessionMeta), [filtered, data.sessionMeta]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);

  const contextLine = useMemo(() => {
    if (filtered.length === 0) return 'no entries match filters';
    const first = new Date(filtered[0]!.t);
    const last = new Date(filtered[filtered.length - 1]!.t);
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (first.toDateString() === last.toDateString()) return fmt(first);
    return `${fmt(first)} → ${fmt(last)}`;
  }, [filtered]);

  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <span className="brand-mark">tokens-gone</span>
          <span className="brand-sub">Claude Code usage</span>
        </div>
        <div className="right">
          <span>
            <span className="stat-dot" />
            {data.entries.length.toLocaleString()} entries · {data.stats.files} files · {data.stats.tookMs}ms
          </span>
          <button
            className={`refresh${refreshing ? ' spinning' : ''}`}
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </header>

      <ActiveFilters filters={filters} setFilters={setFilters} entries={data.entries} />

      <Hero totals={t} costByType={costByType} contextLine={contextLine} />

      <div className="section">
        <div className="section-head">
          <h2>Activity · past year</h2>
          <span className="meta">click any day to drill in</span>
        </div>
        <ActivityHeatmap
          days={yearDays}
          selectedDayMs={selectedDayMs}
          onDayClick={toggleDay}
        />
        <StatStrip stats={stats} burnPerHour={burn.perHour} />
      </div>

      <div className="section">
        <Timeline entries={filtered} rangeFrom={filters.from} rangeTo={filters.to} />
      </div>

      <div className="section cols-2">
        <BreakdownTable
          rows={byModelRows}
          title="By model"
          keyLabel="Model"
          isModel
          onRowClick={(k) => toggleFilter('models', k)}
          selected={filters.models}
          decomposeBy="type"
        />
        <BreakdownTable
          rows={byProjectRows}
          title="By project"
          keyLabel="Project"
          onRowClick={(k) => toggleFilter('projects', k)}
          selected={filters.projects}
          decomposeBy="model"
        />
      </div>

      <div className="section">
        <div className="section-head">
          <h2>When you work</h2>
          <span className="meta">hour of day × weekday</span>
        </div>
        <HourGrid entries={filtered} />
      </div>

      <div className="section">
        <SessionTable sessions={sess} onSelect={setSelectedSession} />
      </div>

      {selectedSession && (
        <SessionDetail
          session={selectedSession}
          allEntries={data.entries}
          onClose={() => setSelectedSession(null)}
        />
      )}

      <footer className="app-foot">
        <ThemeSwitch />
      </footer>
    </div>
  );
}

type ThemePref = 'system' | 'light' | 'dark';

function readThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'system';
}

function applyTheme(pref: ThemePref): void {
  const resolved =
    pref === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : pref;
  document.documentElement.dataset.theme = resolved;
}

function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  function pick(next: ThemePref) {
    setPref(next);
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {}
  }

  const opts: ThemePref[] = ['system', 'light', 'dark'];
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      <span className="lbl">Theme</span>
      <div className="group">
        {opts.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={pref === o}
            onClick={() => pick(o)}
          >
            {o[0]!.toUpperCase() + o.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

function emptyTotals(): Totals {
  return { count: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0 };
}

function addToTotals(t: Totals, e: Entry, cost: number): void {
  t.count++;
  t.input += e.i;
  t.output += e.o;
  t.cacheWrite += e.cc;
  t.cacheRead += e.cr;
  t.total += e.i + e.o + e.cc + e.cr;
  t.cost += cost;
}
