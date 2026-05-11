import { useEffect, useMemo, useRef, useState } from 'react';
import type { Entry, Filters as F, Harness } from '../types';
import { HARNESS_LABELS, entryHarness } from '../types';
import { modelShort } from '../format';

/**
 * Active filters rendered as breadcrumbs at the top of the view —
 * "All time · Opus 4.7 · webmaster". Each segment is a clickable chip
 * that removes itself; the base ("All time"/"7d"/etc) opens a date popover.
 * Replaces the chip-soup filters panel.
 */
export function ActiveFilters({
  filters,
  setFilters,
  entries,
}: {
  filters: F;
  setFilters: (f: F) => void;
  entries: Entry[];
}) {
  const rangeLabel = useMemo(() => describeRange(filters), [filters]);
  const anyActive =
    filters.from !== null ||
    filters.to !== null ||
    filters.projects.size > 0 ||
    filters.models.size > 0 ||
    filters.harnesses.size > 0;

  const { allModels, allProjects, allHarnesses } = useMemo(() => {
    const ms = new Map<string, number>();
    const ps = new Map<string, number>();
    const hs = new Map<Harness, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      ms.set(e.m, (ms.get(e.m) ?? 0) + 1);
      ps.set(e.p, (ps.get(e.p) ?? 0) + 1);
      const h = entryHarness(e);
      hs.set(h, (hs.get(h) ?? 0) + 1);
    }
    return {
      allModels: [...ms.entries()].sort((a, b) => b[1] - a[1]),
      allProjects: [...ps.entries()].sort((a, b) => b[1] - a[1]),
      // Sorted by count desc; cast keeps the string-keyed MultiSelect generic happy.
      allHarnesses: [...hs.entries()].sort((a, b) => b[1] - a[1]) as [string, number][],
    };
  }, [entries]);

  // Only show the harness chip/picker if the dataset has more than one source.
  // For Claude-only users (the vast majority) this stays hidden so the
  // breadcrumb stays uncluttered.
  const showHarnessPicker = allHarnesses.length > 1;

  function removeProject(p: string) {
    const next = new Set(filters.projects);
    next.delete(p);
    setFilters({ ...filters, projects: next });
  }
  function removeModel(m: string) {
    const next = new Set(filters.models);
    next.delete(m);
    setFilters({ ...filters, models: next });
  }
  function removeHarness(h: Harness) {
    const next = new Set(filters.harnesses);
    next.delete(h);
    setFilters({ ...filters, harnesses: next });
  }

  return (
    <div className="crumbs">
      <DatePopover filters={filters} setFilters={setFilters}>
        <span className="crumb">
          {rangeLabel}
        </span>
      </DatePopover>

      {[...filters.harnesses].flatMap((h) => [
        <span className="sep" key={`sep-h-${h}`}>›</span>,
        <span className="crumb" key={`h-${h}`} onClick={() => removeHarness(h)}>
          {HARNESS_LABELS[h]} <span className="x">×</span>
        </span>,
      ])}

      {[...filters.models].flatMap((m) => [
        <span className="sep" key={`sep-m-${m}`}>›</span>,
        <span className="crumb" key={`m-${m}`} onClick={() => removeModel(m)}>
          {modelShort(m)} <span className="x">×</span>
        </span>,
      ])}

      {[...filters.projects].flatMap((p) => [
        <span className="sep" key={`sep-p-${p}`}>›</span>,
        <span className="crumb" key={`p-${p}`} onClick={() => removeProject(p)}>
          {p} <span className="x">×</span>
        </span>,
      ])}

      {showHarnessPicker && (
        <MultiSelect
          label="+ harness"
          options={allHarnesses}
          renderLabel={(v) => HARNESS_LABELS[v as Harness] ?? v}
          selected={filters.harnesses as unknown as Set<string>}
          onChange={(next) =>
            setFilters({ ...filters, harnesses: next as Set<Harness> })
          }
        />
      )}
      <MultiSelect
        label="+ model"
        options={allModels}
        renderLabel={(v) => modelShort(v)}
        selected={filters.models}
        onChange={(next) => setFilters({ ...filters, models: next })}
      />
      <MultiSelect
        label="+ project"
        options={allProjects}
        renderLabel={(v) => v}
        selected={filters.projects}
        onChange={(next) => setFilters({ ...filters, projects: next })}
      />

      {anyActive && (
        <span
          className="clear"
          onClick={() =>
            setFilters({
              from: null,
              to: null,
              projects: new Set(),
              models: new Set(),
              harnesses: new Set(),
            })
          }
        >
          clear all
        </span>
      )}
    </div>
  );
}

function describeRange(f: F): string {
  if (f.from === null && f.to === null) return 'All time';
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (f.from !== null && f.to !== null) {
    return `${fmt(f.from)} – ${fmt(f.to - 1)}`;
  }
  if (f.from !== null) return `since ${fmt(f.from)}`;
  return `until ${fmt(f.to! - 1)}`;
}

function DatePopover({
  filters,
  setFilters,
  children,
}: {
  filters: F;
  setFilters: (f: F) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function setRange(days: number | null) {
    if (days === null) {
      setFilters({ ...filters, from: null, to: null });
      setOpen(false);
      return;
    }
    const now = Date.now();
    const today = startOfDay(now);
    const from = days === 0 ? today : startOfDay(now - (days - 1) * 86400000);
    setFilters({ ...filters, from, to: null });
    setOpen(false);
  }

  return (
    <div className="filter-control" ref={ref}>
      <div onClick={() => setOpen(!open)} style={{ cursor: 'pointer', display: 'inline' }}>
        {children}
      </div>
      {open && (
        <div className="filter-popover" style={{ minWidth: 260 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
            <PresetBtn onClick={() => setRange(0)}>Today</PresetBtn>
            <PresetBtn onClick={() => setRange(7)}>7 days</PresetBtn>
            <PresetBtn onClick={() => setRange(30)}>30 days</PresetBtn>
            <PresetBtn onClick={() => setRange(90)}>90 days</PresetBtn>
            <PresetBtn onClick={() => setRange(365)}>1 year</PresetBtn>
            <PresetBtn onClick={() => setRange(null)}>All time</PresetBtn>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
            <input
              type="date"
              value={filters.from ? isoFromMs(filters.from) : ''}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  from: e.target.value ? new Date(e.target.value).getTime() : null,
                })
              }
              style={{ flex: 1 }}
            />
            <span className="muted">→</span>
            <input
              type="date"
              value={filters.to ? isoFromMs(filters.to - 1) : ''}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  to: e.target.value ? new Date(e.target.value).getTime() + 86400000 : null,
                })
              }
              style={{ flex: 1 }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PresetBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ fontSize: 11, padding: '3px 8px' }}>
      {children}
    </button>
  );
}

function MultiSelect({
  label,
  options,
  selected,
  renderLabel,
  onChange,
}: {
  label: string;
  options: [string, number][];
  selected: Set<string>;
  renderLabel: (v: string) => string;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setQ('');
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const filtered = useMemo(
    () => (q ? options.filter(([k]) => k.toLowerCase().includes(q.toLowerCase())) : options),
    [options, q],
  );

  return (
    <div className="filter-control" ref={ref}>
      <span
        className="crumb-base"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen(!open)}
      >
        {label}
      </span>
      {open && (
        <div className="filter-popover">
          {options.length > 8 && (
            <input
              type="search"
              placeholder="search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          )}
          {filtered.slice(0, 60).map(([v, n]) => {
            const sel = selected.has(v);
            return (
              <div
                key={v}
                className={`opt${sel ? ' selected' : ''}`}
                onClick={() => {
                  const next = new Set(selected);
                  if (sel) next.delete(v);
                  else next.add(v);
                  onChange(next);
                }}
              >
                <span>
                  {sel ? '✓ ' : '  '}
                  {renderLabel(v)}
                </span>
                <span className="cnt">{n.toLocaleString()}</span>
              </div>
            );
          })}
          {filtered.length > 60 && (
            <div className="opt muted">+{filtered.length - 60} more — refine search</div>
          )}
          {filtered.length === 0 && <div className="opt muted">no matches</div>}
        </div>
      )}
    </div>
  );
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
