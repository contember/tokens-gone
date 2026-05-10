import { useEffect, useMemo, useState } from 'react';
import type { ApiData, Entry, Filters } from './types';
import { applyFilters, groupBy, sessions, totals } from './aggregate';
import { FiltersBar } from './components/Filters';
import { Summary } from './components/Summary';
import { Timeline } from './components/Timeline';
import { BreakdownTable } from './components/BreakdownTable';
import { SessionTable } from './components/SessionTable';

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
  if (!data) return <div className="app"><div className="loading">Loading data…</div></div>;

  return <Dashboard data={data} filters={filters} setFilters={setFilters} onRefresh={refresh} refreshing={refreshing} />;
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
  const byProject = useMemo(() => groupBy(filtered, (e) => e.p), [filtered]);
  const byModel = useMemo(() => groupBy(filtered, (e) => e.m), [filtered]);
  const sess = useMemo(() => sessions(filtered), [filtered]);

  function toggleFilter(key: 'projects' | 'models', value: string) {
    const next = new Set(filters[key]);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setFilters({ ...filters, [key]: next });
  }

  return (
    <div className="app">
      <header className="top">
        <h1>ccdashboard</h1>
        <div className="meta">
          {data.stats.files} files · {data.stats.cachedFiles} cached · scanned in{' '}
          {data.stats.tookMs}ms · {data.entries.length.toLocaleString()} entries
          <button
            onClick={onRefresh}
            disabled={refreshing}
            style={{ marginLeft: 12 }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <FiltersBar entries={data.entries} filters={filters} onChange={setFilters} />
      <Summary totals={t} />
      <Timeline entries={filtered} />

      <div className="grid-2">
        <BreakdownTable
          rows={byModel}
          title="By model"
          keyLabel="Model"
          isModel
          onRowClick={(k) => toggleFilter('models', k)}
          selected={filters.models}
        />
        <BreakdownTable
          rows={byProject}
          title="By project"
          keyLabel="Project"
          onRowClick={(k) => toggleFilter('projects', k)}
          selected={filters.projects}
        />
      </div>

      <SessionTable sessions={sess} />
    </div>
  );
}
