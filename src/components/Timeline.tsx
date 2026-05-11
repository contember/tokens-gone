import { useMemo, useState } from 'react';
import type { Entry } from '../types';
import { dayKey, hourBucket, monthKey, weekBucket } from '../aggregate';
import { costForEntry } from '../pricing';
import { BarChart, type ChartPoint } from './Chart';
import { fmtMoney, modelClass, modelShort } from '../format';

type Granularity = 'hour' | 'day' | 'week' | 'month';

const MODEL_COLOR: Record<string, string> = {
  opus: 'var(--opus)',
  sonnet: 'var(--sonnet)',
  haiku: 'var(--haiku)',
  other: 'var(--other)',
};

/**
 * Cost-over-time chart with granularity switcher. Picks a sensible default
 * based on the visible range: narrow ranges default to hourly, wide ones
 * to monthly. Stacking is by model family (opus/sonnet/haiku/other).
 */
export function Timeline({ entries, rangeFrom, rangeTo }: { entries: Entry[]; rangeFrom: number | null; rangeTo: number | null }) {
  const defaultGran = useMemo<Granularity>(() => {
    if (entries.length === 0) return 'day';
    const first = rangeFrom ?? entries[0]!.t;
    const last = rangeTo ?? entries[entries.length - 1]!.t;
    const days = (last - first) / 86400000;
    if (days <= 2) return 'hour';
    if (days <= 60) return 'day';
    if (days <= 365) return 'week';
    return 'month';
  }, [entries, rangeFrom, rangeTo]);

  const [gran, setGranState] = useState<Granularity>(defaultGran);
  // If the range changes such that the previous granularity is silly,
  // adopt the new default — but only once per range change, not on every
  // render. useMemo above re-evaluates on entries change; we sync here.
  const [lastDefault, setLastDefault] = useState(defaultGran);
  if (lastDefault !== defaultGran) {
    setLastDefault(defaultGran);
    setGranState(defaultGran);
  }

  const { points, total } = useMemo(() => {
    if (entries.length === 0) return { points: [] as ChartPoint[], total: 0 };
    const buckets = new Map<string, { full: string; label: string; sort: number; byModel: Map<string, number> }>();
    // Hot loop: only compute the bucket *key* per entry (cheap — integer
    // math). The label / full / sort strings need toLocaleString which is
    // expensive, so we only fill them when materializing a new bucket.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const key = bucketKey(e.t, gran);
      let b = buckets.get(key);
      if (!b) {
        const meta = bucketize(e.t, gran);
        b = { full: meta.full, label: meta.label, sort: meta.sort, byModel: new Map() };
        buckets.set(key, b);
      }
      const cls = modelClass(e.m) || 'other';
      b.byModel.set(cls, (b.byModel.get(cls) ?? 0) + costForEntry(e));
    }

    const points = [...buckets.values()]
      .sort((a, b) => a.sort - b.sort)
      .map<ChartPoint>((b) => {
        let total = 0;
        const segments: ChartPoint['segments'] = [];
        for (const k of ['opus', 'sonnet', 'haiku', 'other'] as const) {
          const v = b.byModel.get(k);
          if (v != null && v > 0) {
            segments.push({ value: v, color: MODEL_COLOR[k]!, label: labelForFamily(k) });
            total += v;
          }
        }
        return { label: b.label, full: b.full, value: total, segments };
      });

    return { points, total: points.reduce((s, p) => s + p.value, 0) };
  }, [entries, gran]);

  return (
    <div>
      <div className="section-head">
        <h2>Cost over time</h2>
        <div className="row" style={{ gap: 4 }}>
          <span className="meta" style={{ marginRight: 12 }}>
            {fmtMoney(total)} · {points.length} {gran}s
          </span>
          {(['hour', 'day', 'week', 'month'] as Granularity[]).map((g) => (
            <button
              key={g}
              className={g === gran ? 'active' : ''}
              onClick={() => setGranState(g)}
            >
              {g}
            </button>
          ))}
        </div>
      </div>
      <BarChart data={points} height={220} />
      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: 'var(--t-3)' }}>
        <Legend cls="opus" />
        <Legend cls="sonnet" />
        <Legend cls="haiku" />
      </div>
    </div>
  );
}

function Legend({ cls }: { cls: 'opus' | 'sonnet' | 'haiku' }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 1, background: `var(--${cls})` }} />
      <span className={`tag ${cls}`} style={{ fontSize: 10, padding: '0 4px' }}>
        {labelForFamily(cls)}
      </span>
    </span>
  );
}

function labelForFamily(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/**
 * Cheap bucket-key function — integer math only, no Intl. Called once
 * per entry in the timeline loop, so it must avoid allocations and
 * `toLocaleString`. The labels (which need locale formatting) are
 * computed lazily by `bucketize` when a bucket is first materialized.
 */
function bucketKey(t: number, gran: Granularity): string {
  if (gran === 'hour') return String(hourBucket(t));
  if (gran === 'day') return dayKey(t);
  if (gran === 'week') return String(weekBucket(t));
  return monthKey(t);
}

function bucketize(t: number, gran: Granularity): { key: string; label: string; full: string; sort: number } {
  if (gran === 'hour') {
    const b = hourBucket(t);
    const d = new Date(b);
    return {
      key: String(b),
      label: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}h`,
      full: d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      sort: b,
    };
  }
  if (gran === 'day') {
    const k = dayKey(t);
    const d = new Date(Date.parse(k));
    return {
      key: k,
      label: k.slice(5),
      full: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
      sort: Date.parse(k),
    };
  }
  if (gran === 'week') {
    const b = weekBucket(t);
    const d = new Date(b);
    return {
      key: String(b),
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      full: `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
      sort: b,
    };
  }
  const k = monthKey(t);
  return {
    key: k,
    label: k,
    full: new Date(Date.parse(k + '-01')).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    sort: Date.parse(k + '-01'),
  };
}
