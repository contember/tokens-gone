import { useMemo, useState } from 'react';
import type { Entry } from '../types';
import { dayKey, hourBucket, monthKey, weekBucket } from '../aggregate';
import { costForEntry } from '../pricing';
import { BarChart, type ChartPoint } from './Chart';
import { fmtMoney, modelClass } from '../format';

type Granularity = 'hour' | 'day' | 'week' | 'month';

const MODEL_COLORS: Record<string, string> = {
  opus: '#bb9af7',
  sonnet: '#7aa2f7',
  haiku: '#9ece6a',
};

export function Timeline({ entries }: { entries: Entry[] }) {
  const [gran, setGran] = useState<Granularity>('day');

  const points = useMemo<ChartPoint[]>(() => {
    if (entries.length === 0) return [];
    const buckets = new Map<string, { label: string; sort: number; byModel: Map<string, number> }>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      let key: string;
      let label: string;
      let sort: number;
      if (gran === 'hour') {
        const b = hourBucket(e.t);
        sort = b;
        key = String(b);
        const d = new Date(b);
        label = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}h`;
      } else if (gran === 'day') {
        key = dayKey(e.t);
        sort = Date.parse(key);
        label = key.slice(5);
      } else if (gran === 'week') {
        const b = weekBucket(e.t);
        sort = b;
        key = String(b);
        const d = new Date(b);
        label = `${d.getMonth() + 1}/${d.getDate()}`;
      } else {
        key = monthKey(e.t);
        sort = Date.parse(key + '-01');
        label = key;
      }
      let b = buckets.get(key);
      if (!b) {
        b = { label, sort, byModel: new Map() };
        buckets.set(key, b);
      }
      const cls = modelClass(e.m) || 'other';
      b.byModel.set(cls, (b.byModel.get(cls) ?? 0) + costForEntry(e));
    }
    return [...buckets.values()]
      .sort((a, b) => a.sort - b.sort)
      .map<ChartPoint>((b) => {
        let total = 0;
        const segments: { value: number; color: string }[] = [];
        // Stable order: opus, sonnet, haiku, other
        for (const k of ['opus', 'sonnet', 'haiku', 'other']) {
          const v = b.byModel.get(k);
          if (v != null && v > 0) {
            segments.push({ value: v, color: MODEL_COLORS[k] ?? '#888' });
            total += v;
          }
        }
        return { label: b.label, value: total, segments };
      });
  }, [entries, gran]);

  const total = points.reduce((s, p) => s + p.value, 0);

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Cost over time</h2>
        <div className="spacer" />
        <span className="muted" style={{ marginRight: 8 }}>
          {fmtMoney(total)} across {points.length} buckets
        </span>
        {(['hour', 'day', 'week', 'month'] as Granularity[]).map((g) => (
          <button
            key={g}
            className={g === gran ? 'active' : ''}
            onClick={() => setGran(g)}
          >
            {g}
          </button>
        ))}
      </div>
      <BarChart data={points} height={220} />
    </div>
  );
}
