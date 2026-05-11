import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DayStat } from '../aggregate';
import { fmtMoney, modelShort, modelClass } from '../format';

const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/**
 * GitHub-style contribution grid scaled to Claude Code spend. Cells are
 * one day each, color intensity bucketed by cost. Click toggles a single-
 * day filter via `onDayClick`; the currently filtered day (if it is a
 * single-day window) gets a ring.
 *
 * Buckets use quantile-ish thresholds derived from the data's own
 * distribution, so a quiet user and a heavy user both get a readable
 * gradient — fixed dollar thresholds would either crush a quiet user's
 * data to one shade or saturate a heavy user's at the top bucket.
 */
export function ActivityHeatmap({
  days,
  selectedDayMs,
  onDayClick,
}: {
  days: DayStat[];
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

    const sequence: (DayStat | null)[] = [];
    for (let i = 0; i < padHead; i++) sequence.push(null);
    for (const d of days) sequence.push(d);
    for (let i = 0; i < padTail; i++) sequence.push(null);

    // Derive thresholds from active days only so empty cells don't skew
    // the distribution. p20 / p50 / p80 / p95 give four visible tiers.
    const costs = days.filter((d) => d.cost > 0).map((d) => d.cost).sort((a, b) => a - b);
    const q = (p: number) =>
      costs.length === 0 ? 0 : costs[Math.min(costs.length - 1, Math.floor(costs.length * p))]!;
    const thresholds = [q(0.2), q(0.5), q(0.8), q(0.95)];

    function level(cost: number): 0 | 1 | 2 | 3 | 4 {
      if (cost <= 0) return 0;
      if (cost <= thresholds[0]!) return 1;
      if (cost <= thresholds[1]!) return 2;
      if (cost <= thresholds[2]!) return 3;
      return 4;
    }

    const cells: Cell[] = sequence.map((d, idx) => {
      if (!d) return { kind: 'pad', col: Math.floor(idx / 7), row: idx % 7 };
      return {
        kind: 'day',
        col: Math.floor(idx / 7),
        row: idx % 7,
        day: d,
        level: level(d.cost),
      };
    });

    // Build month-label column positions. Place the label at the column
    // where a month first appears in the top row of that column's week.
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

    const total = days.reduce((s, d) => s + d.cost, 0);
    const activeCells = days.filter((d) => d.cost > 0).length;
    const max = costs[costs.length - 1] ?? 0;

    return { cells, monthCols, total, activeCells, max };
  }, [days]);

  const [hover, setHover] = useState<{ day: DayStat; anchor: DOMRect } | null>(null);

  if (days.length === 0) {
    return <div className="empty">No activity to chart</div>;
  }

  // Position the hover tooltip relative to the cell. We track via state
  // (not CSS hover) so we can show structured content.
  const cols = cells.length / 7;

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
        <span>{activeCells}/{days.length} active days · max {fmtMoney(max)}/day · total {fmtMoney(total)}</span>
        <span className="spacer" />
        <span>less</span>
        <span className="cell" style={{ background: 'var(--heat-0)' }} />
        <span className="cell" style={{ background: 'var(--heat-1)' }} />
        <span className="cell" style={{ background: 'var(--heat-2)' }} />
        <span className="cell" style={{ background: 'var(--heat-3)' }} />
        <span className="cell" style={{ background: 'var(--heat-4)' }} />
        <span>more</span>
      </div>
      {hover && <HeatmapTooltip day={hover.day} anchor={hover.anchor} />}
    </div>
  );
}

function HeatmapTooltip({ day, anchor }: { day: DayStat; anchor: DOMRect }) {
  const top = useMemo(() => {
    const sorted = [...day.byModel.entries()].sort((a, b) => b[1] - a[1]);
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
        {fmtMoney(day.cost)}
      </div>
      <div style={{ color: 'var(--t-3)', fontSize: 11, marginBottom: top.length ? 6 : 0 }}>
        {day.count.toLocaleString()} requests
      </div>
      {top.map(([m, c]) => (
        <div
          key={m}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            fontSize: 11,
            color: 'var(--t-2)',
          }}
        >
          <span>
            <span className={`tag ${modelClass(m)}`} style={{ fontSize: 10, padding: '0 4px' }}>
              {modelShort(m)}
            </span>
          </span>
          <span style={{ fontFamily: 'var(--mono)' }}>{fmtMoney(c)}</span>
        </div>
      ))}
      {day.cost === 0 && <div style={{ color: 'var(--t-3)' }}>no activity</div>}
    </div>
  );
}

type Cell =
  | { kind: 'pad'; col: number; row: number }
  | { kind: 'day'; col: number; row: number; day: DayStat; level: 0 | 1 | 2 | 3 | 4 };

type MonthCol = { col: number; label: string };
