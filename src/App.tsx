import { useEffect, useMemo, useState } from 'react';
import type { ApiData, Entry, Filters } from './types';
import {
  activityStats,
  applyFilters,
  daily,
  groupBy,
  recentBurn,
  sessions,
  totals,
} from './aggregate';
import { costForEntry } from './pricing';
import { ActiveFilters } from './components/ActiveFilters';
import { ActivityHeatmap } from './components/ActivityHeatmap';
import { BreakdownTable } from './components/BreakdownTable';
import { Hero } from './components/Hero';
import { HourGrid } from './components/HourGrid';
import { SessionTable } from './components/SessionTable';
import { StatStrip } from './components/StatStrip';
import { Timeline } from './components/Timeline';

const EMPTY_FILTERS: Filters = {
  from: null,
  to: null,
  projects: new Set(),
  models: new Set(),
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

  const t = useMemo(() => totals(filtered), [filtered]);

  // Cost decomposition by token type — drives the hero bar + legend.
  const costByType = useMemo(() => {
    let input = 0, output = 0, cwrite = 0, cread = 0;
    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i]!;
      // Reverse-engineer the per-type contribution by computing the cost
      // for each type in isolation. Tiered pricing makes this exact —
      // we can't just split a single cost figure proportionally because
      // cache reads and outputs have different per-token rates.
      input += costForEntry({ ...e, o: 0, cc: 0, cr: 0 });
      output += costForEntry({ ...e, i: 0, cc: 0, cr: 0 });
      cwrite += costForEntry({ ...e, i: 0, o: 0, cr: 0 });
      cread += costForEntry({ ...e, i: 0, o: 0, cc: 0 });
    }
    return { input, output, cwrite, cread };
  }, [filtered]);

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
    });
    return daily(yearEntries, from, today + 86400000);
  }, [data.entries, filters.projects, filters.models]);

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

  const byModelRows = useMemo(
    () => buildRows(filtered, (e) => e.m),
    [filtered],
  );
  const byProjectRows = useMemo(
    () => buildRows(filtered, (e) => e.p),
    [filtered],
  );
  const sess = useMemo(() => sessions(filtered), [filtered]);

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
          <span className="brand-mark">ccdashboard</span>
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
        <SessionTable sessions={sess} />
      </div>
    </div>
  );
}

function buildRows(entries: Entry[], keyFn: (e: Entry) => string) {
  const grouped = groupBy(entries, keyFn);
  const byKey = new Map<string, Entry[]>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const k = keyFn(e);
    let arr = byKey.get(k);
    if (!arr) { arr = []; byKey.set(k, arr); }
    arr.push(e);
  }
  return grouped.map(({ key, totals }) => ({
    key,
    totals,
    entries: byKey.get(key) ?? [],
  }));
}
