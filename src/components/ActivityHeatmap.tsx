import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HeatmapDay } from '../aggregate';
import { fmtMoney, modelShort, modelClass } from '../format';

const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

export type HeatmapMode = 'cost' | 'prompts';

/**
 * GitHub-style contribution grid. Cells are one day each; intensity is
 * bucketed by `day.value`, which is dollars in cost mode and prompt count
 * in prompts mode. Click toggles a single-day filter via `onDayClick`.
 *
 * Buckets use quantile-ish thresholds (p20/p50/p80/p95) derived from the
 * data's own distribution, so a quiet user and a heavy user both get a
 * readable gradient — fixed thresholds would either crush the quiet
 * user's data to one shade or saturate a heavy user's at the top bucket.
 */
export function ActivityHeatmap({
  days,
  mode,
  selectedDayMs,
  onDayClick,
}: {
  days: HeatmapDay[];
  mode: HeatmapMode;
  selectedDayMs: number | null;
  onDayClick: (dayMs: number | null) => void;
}) {
  const { cells, monthCols, total, activeCells, max } = useMemo(() => {
    if (days.length === 0) {
      return { cells: [] as Cell[], monthCols: [] as MonthCol[], total: 0, activeCells: 0, max: 0 };
    }

    // Align the grid so each column is a week (Mon → Sun). Pad the head
    // so the first column starts on a Monday; pad the tail so the last
    // column ends on a Sunday. Padding cells are rendered invisible.
    const first = new Date(days[0]!.ms);
    const last = new Date(days[days.length - 1]!.ms);
    const dowFirst = (first.getDay() + 6) % 7; // 0 = Monday
    const dowLast = (last.getDay() + 6) % 7;

    const padHead = dowFirst;
    const padTail = 6 - dowLast;

    const sequence: (HeatmapDay | null)[] = [];
    for (let i = 0; i < padHead; i++) sequence.push(null);
    for (const d of days) sequence.push(d);
    for (let i = 0; i < padTail; i++) sequence.push(null);

    const values = days.filter((d) => d.value > 0).map((d) => d.value).sort((a, b) => a - b);
    const q = (p: number) =>
      values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(values.length * p))]!;
    const thresholds = [q(0.2), q(0.5), q(0.8), q(0.95)];

    function level(v: number): 0 | 1 | 2 | 3 | 4 {
      if (v <= 0) return 0;
      if (v <= thresholds[0]!) return 1;
      if (v <= thresholds[1]!) return 2;
      if (v <= thresholds[2]!) return 3;
      return 4;
    }

    const cells: Cell[] = sequence.map((d, idx) => {
      if (!d) return { kind: 'pad', col: Math.floor(idx / 7), row: idx % 7 };
      return {
        kind: 'day',
        col: Math.floor(idx / 7),
        row: idx % 7,
        day: d,
        level: level(d.value),
      };
    });

    const monthCols: MonthCol[] = [];
    let lastMonth = -1;
    for (let c = 0; c < cells.length / 7; c++) {
      const cellAtTop = cells[c * 7];
      if (cellAtTop?.kind === 'day') {
        const m = new Date(cellAtTop.day.ms).getMonth();
        if (m !== lastMonth) {
          monthCols.push({ col: c, label: MONTH_LABELS[m]! });
          lastMonth = m;
        }
      }
    }

    const total = days.reduce((s, d) => s + d.value, 0);
    const activeCells = days.filter((d) => d.value > 0).length;
    const max = values[values.length - 1] ?? 0;

    return { cells, monthCols, total, activeCells, max };
  }, [days]);

  const [hover, setHover] = useState<{ day: HeatmapDay; anchor: DOMRect } | null>(null);

  if (days.length === 0) {
    return <div className="empty">No activity to chart</div>;
  }

  const cols = cells.length / 7;
  const fmt = mode === 'cost' ? fmtMoney : fmtPrompts;
  const totalLabel = mode === 'cost' ? `total ${fmt(total)}` : `total ${fmt(total)}`;

  return (
    <div>
      <div className="heatmap">
        <div
          className="heatmap-months"
          style={{ gridTemplateColumns: `repeat(${cols}, 13px)` }}
        >
          {monthCols.map((m) => (
            <div key={`${m.col}-${m.label}`} style={{ gridColumn: m.col + 1 }}>
              {m.label}
            </div>
          ))}
        </div>
        <div className="heatmap-wrap">
          <div className="heatmap-days">
            <div></div>
            <div>Tue</div>
            <div></div>
            <div>Thu</div>
            <div></div>
            <div>Sat</div>
            <div></div>
          </div>
          <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${cols}, 13px)` }}>
            {cells.map((c, i) => {
              if (c.kind === 'pad') {
                return (
                  <div
                    key={i}
                    style={{
                      gridColumn: c.col + 1,
                      gridRow: c.row + 1,
                      visibility: 'hidden',
                    }}
                  />
                );
              }
              const sel = selectedDayMs === c.day.ms;
              return (
                <div
                  key={c.day.date}
                  className={`heatmap-cell l${c.level}${sel ? ' selected' : ''}`}
                  style={{ gridColumn: c.col + 1, gridRow: c.row + 1 }}
                  onMouseEnter={(e) =>
                    setHover({ day: c.day, anchor: e.currentTarget.getBoundingClientRect() })
                  }
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onDayClick(sel ? null : c.day.ms)}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="heatmap-legend">
        <span>
          {activeCells}/{days.length} active days · max {fmt(max)}/day · {totalLabel}
        </span>
        <span className="spacer" />
        <span>less</span>
        <span className="cell" style={{ background: 'var(--heat-0)' }} />
        <span className="cell" style={{ background: 'var(--heat-1)' }} />
        <span className="cell" style={{ background: 'var(--heat-2)' }} />
        <span className="cell" style={{ background: 'var(--heat-3)' }} />
        <span className="cell" style={{ background: 'var(--heat-4)' }} />
        <span>more</span>
      </div>
      {hover && <HeatmapTooltip day={hover.day} anchor={hover.anchor} mode={mode} />}
    </div>
  );
}

function fmtPrompts(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

function HeatmapTooltip({
  day,
  anchor,
  mode,
}: {
  day: HeatmapDay;
  anchor: DOMRect;
  mode: HeatmapMode;
}) {
  const top = useMemo(() => {
    const sorted = [...day.breakdown.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 3);
  }, [day]);
  const d = new Date(day.ms);
  const label = d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Position above the cell, centered. After mount, measure the tooltip
  // and clamp into the viewport; flip below if it would clip the top.
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    let left = anchor.left + anchor.width / 2 - r.width / 2;
    let top = anchor.top - r.height - gap;
    if (top < margin) top = anchor.bottom + gap;
    if (left < margin) left = margin;
    if (left + r.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - r.width;
    }
    setPos({ left, top });
  }, [anchor, day]);

  const primary = mode === 'cost' ? fmtMoney(day.value) : `${day.count.toLocaleString()} prompts`;
  const secondary =
    mode === 'cost' ? `${day.count.toLocaleString()} requests` : undefined;

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        background: 'var(--ink-2)',
        border: '1px solid var(--line-strong)',
        borderRadius: 'var(--r-2)',
        padding: '10px 12px',
        fontSize: 11,
        minWidth: 200,
        pointerEvents: 'none',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.5)',
        zIndex: 50,
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--t-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--t-1)', marginBottom: 6, letterSpacing: '-0.02em' }}>
        {primary}
      </div>
      {secondary && (
        <div style={{ color: 'var(--t-3)', fontSize: 11, marginBottom: top.length ? 6 : 0 }}>
          {secondary}
        </div>
      )}
      {top.map(([k, v]) => (
        <div
          key={k}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            fontSize: 11,
            color: 'var(--t-2)',
          }}
        >
          <span>
            {mode === 'cost' ? (
              <span className={`tag ${modelClass(k)}`} style={{ fontSize: 10, padding: '0 4px' }}>
                {modelShort(k)}
              </span>
            ) : (
              <span style={{ fontSize: 11 }}>{k}</span>
            )}
          </span>
          <span style={{ fontFamily: 'var(--mono)' }}>
            {mode === 'cost' ? fmtMoney(v) : v.toLocaleString()}
          </span>
        </div>
      ))}
      {day.value === 0 && <div style={{ color: 'var(--t-3)' }}>no activity</div>}
    </div>
  );
}

type Cell =
  | { kind: 'pad'; col: number; row: number }
  | { kind: 'day'; col: number; row: number; day: HeatmapDay; level: 0 | 1 | 2 | 3 | 4 };

type MonthCol = { col: number; label: string };
