import { useMemo } from 'react';
import type { Entry, Filters as F } from '../types';
import { modelShort } from '../format';

type Props = {
  entries: Entry[];
  filters: F;
  onChange: (f: F) => void;
};

const RANGES: { label: string; days: number | null }[] = [
  { label: 'Today', days: 0 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: null },
];

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function FiltersBar({ entries, filters, onChange }: Props) {
  const { projects, models } = useMemo(() => {
    const pSet = new Map<string, number>();
    const mSet = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      pSet.set(e.p, (pSet.get(e.p) ?? 0) + 1);
      mSet.set(e.m, (mSet.get(e.m) ?? 0) + 1);
    }
    const ps = [...pSet.entries()].sort((a, b) => b[1] - a[1]);
    const ms = [...mSet.entries()].sort((a, b) => b[1] - a[1]);
    return { projects: ps.map(([k]) => k), models: ms.map(([k]) => k) };
  }, [entries]);

  function setRange(days: number | null) {
    if (days === null) {
      onChange({ ...filters, from: null, to: null });
      return;
    }
    const now = Date.now();
    const today = startOfDay(now);
    const from = days === 0 ? today : startOfDay(now - (days - 1) * 86400000);
    onChange({ ...filters, from, to: null });
  }

  function activeRange(): number | null | undefined {
    if (filters.from === null && filters.to === null) return null;
    if (filters.to !== null) return undefined;
    const now = Date.now();
    for (const r of RANGES) {
      if (r.days === null) continue;
      const expected =
        r.days === 0 ? startOfDay(now) : startOfDay(now - (r.days - 1) * 86400000);
      if (filters.from === expected) return r.days;
    }
    return undefined;
  }

  function toggleSet(set: Set<string>, value: string, key: 'projects' | 'models') {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...filters, [key]: next });
  }

  const ar = activeRange();

  return (
    <div className="panel">
      <h2>Filters</h2>
      <div className="filter-row" style={{ marginBottom: 10 }}>
        <label>Range:</label>
        {RANGES.map((r) => (
          <button
            key={r.label}
            className={ar === r.days ? 'active' : ''}
            onClick={() => setRange(r.days)}
          >
            {r.label}
          </button>
        ))}
        <input
          type="date"
          value={filters.from ? toDateInput(filters.from) : ''}
          onChange={(e) =>
            onChange({
              ...filters,
              from: e.target.value ? new Date(e.target.value).getTime() : null,
            })
          }
        />
        <span className="muted">→</span>
        <input
          type="date"
          value={filters.to ? toDateInput(filters.to) : ''}
          onChange={(e) =>
            onChange({
              ...filters,
              to: e.target.value
                ? new Date(e.target.value).getTime() + 86400000
                : null,
            })
          }
        />
      </div>

      <div className="filter-row" style={{ marginBottom: 10 }}>
        <label>Models:</label>
        {models.map((m) => (
          <span
            key={m}
            className={`chip ${filters.models.has(m) ? 'active' : ''}`}
            onClick={() => toggleSet(filters.models, m, 'models')}
          >
            {modelShort(m)}
          </span>
        ))}
        {filters.models.size > 0 && (
          <button onClick={() => onChange({ ...filters, models: new Set() })}>
            clear
          </button>
        )}
      </div>

      <div className="filter-row">
        <label>Projects:</label>
        {projects.slice(0, 20).map((p) => (
          <span
            key={p}
            className={`chip ${filters.projects.has(p) ? 'active' : ''}`}
            onClick={() => toggleSet(filters.projects, p, 'projects')}
          >
            {p}
          </span>
        ))}
        {projects.length > 20 && (
          <span className="muted">+{projects.length - 20} more</span>
        )}
        {filters.projects.size > 0 && (
          <button onClick={() => onChange({ ...filters, projects: new Set() })}>
            clear
          </button>
        )}
      </div>
    </div>
  );
}

function toDateInput(t: number): string {
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
