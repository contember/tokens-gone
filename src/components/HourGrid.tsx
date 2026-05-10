import { useMemo } from 'react';
import type { Entry } from '../types';
import { costForEntry } from '../pricing';
import { fmtMoney } from '../format';

/**
 * 7 × 24 grid of weekday × hour-of-day. Cell intensity = cost. Reveals
 * when you actually work the AI — Sunday at 11pm, Tuesday at 9am.
 * Cheap to compute (single pass) and complements the year heatmap by
 * answering the question "what's my working rhythm?" not "what's my run rate?".
 */
export function HourGrid({ entries }: { entries: Entry[] }) {
  const { grid, max } = useMemo(() => {
    const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let max = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const d = new Date(e.t);
      const dow = (d.getDay() + 6) % 7; // 0 = Monday
      const h = d.getHours();
      const c = costForEntry(e);
      grid[dow]![h]! += c;
      if (grid[dow]![h]! > max) max = grid[dow]![h]!;
    }
    return { grid, max };
  }, [entries]);

  if (entries.length === 0) return <div className="empty">No activity to chart</div>;

  function level(v: number): number {
    if (v <= 0) return 0;
    const r = v / max;
    if (r < 0.1) return 1;
    if (r < 0.3) return 2;
    if (r < 0.6) return 3;
    return 4;
  }

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '32px repeat(24, 1fr)', gap: 2, fontSize: 9, color: 'var(--t-3)', fontFamily: 'var(--mono)', letterSpacing: '0.02em' }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} style={{ textAlign: 'center', visibility: h % 3 === 0 ? 'visible' : 'hidden' }}>
            {String(h).padStart(2, '0')}
          </span>
        ))}
        {days.flatMap((day, dow) => [
          <span key={`label-${day}`} style={{ alignSelf: 'center' }}>{day}</span>,
          ...Array.from({ length: 24 }, (_, h) => {
            const v = grid[dow]![h]!;
            return (
              <div
                key={`${day}-${h}`}
                data-tooltip={`${day} ${String(h).padStart(2, '0')}:00 — ${fmtMoney(v)}`}
                style={{
                  height: 16,
                  borderRadius: 2,
                  background: `var(--heat-${level(v)})`,
                }}
              />
            );
          }),
        ])}
      </div>
    </div>
  );
}
