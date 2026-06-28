import { useMemo, useState } from 'react';
import type { Entry } from '../types';
import type { Totals } from '../aggregate';
import { fmtInt, fmtMoney, fmtTokens, modelClass, modelShort } from '../format';
import { DecompBar, type Segment } from './DecompBar';
import { FAMILIES, OTHER, familyByKey, familyOf } from '../families';
import { costForEntry } from '../pricing';

export type Row = {
  key: string;
  totals: Totals;
  /**
   * Raw entries for this row (used to compute the decomposition split).
   * For model rows the split is by token-type cost; for project rows it's
   * by model — see `decomposeBy`.
   */
  entries: Entry[];
};

type SortKey = 'cost' | 'count' | 'total';

/**
 * Breakdown table — each row carries:
 *  - background fill proportional to row's share of grand total cost
 *  - a decomposition bar showing the row's shape (token types or models)
 *  - aligned mono numerics for fast scanning
 */
export function BreakdownTable({
  rows,
  title,
  keyLabel,
  isModel,
  onRowClick,
  selected,
  decomposeBy,
  topN,
}: {
  rows: Row[];
  title: string;
  keyLabel: string;
  isModel?: boolean;
  onRowClick?: (key: string) => void;
  selected?: Set<string>;
  /** "type" = split by input/output/cwrite/cread; "model" = split by family */
  decomposeBy: 'type' | 'model';
  topN?: number;
}) {
  const [sort, setSort] = useState<SortKey>('cost');
  const [asc, setAsc] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const [hover, setHover] = useState<HoverState | null>(null);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = a.totals[sort];
      const vb = b.totals[sort];
      return asc ? va - vb : vb - va;
    });
    return copy;
  }, [rows, sort, asc]);

  const grandTotal = useMemo(
    () => rows.reduce((s, r) => s + r.totals.cost, 0),
    [rows],
  );

  // Bar length encodes magnitude: each bar is scaled relative to the largest
  // value of the *currently sorted* metric, so the bars line up with the
  // ordering you see (longest on top when sorted descending).
  const maxMetric = useMemo(
    () => rows.reduce((m, r) => Math.max(m, r.totals[sort]), 0),
    [rows, sort],
  );

  const visible = showAll ? sorted : sorted.slice(0, topN ?? 8);

  function header(col: SortKey, label: string) {
    return (
      <th
        className={sort === col ? `sorted ${asc ? 'asc' : ''}` : ''}
        onClick={() => {
          if (sort === col) setAsc(!asc);
          else {
            setSort(col);
            setAsc(false);
          }
        }}
      >
        {label}
      </th>
    );
  }

  return (
    <div>
      <div className="section-head">
        <h2>{title}</h2>
        <span className="meta">{rows.length} {rows.length === 1 ? keyLabel.toLowerCase() : keyLabel.toLowerCase() + 's'}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>{keyLabel}</th>
            <th style={{ width: '32%' }}>Shape</th>
            {header('cost', 'Cost')}
            {header('count', 'Reqs')}
            {header('total', 'Tokens')}
            <th>%</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const pct = grandTotal > 0 ? (r.totals.cost / grandTotal) * 100 : 0;
            const isSelected = selected?.has(r.key) ?? false;
            const segments = computeSegments(r, decomposeBy);
            const frac = maxMetric > 0 ? r.totals[sort] / maxMetric : 0;
            return (
              <tr
                key={r.key}
                onClick={onRowClick ? () => onRowClick(r.key) : undefined}
                style={{ cursor: onRowClick ? 'pointer' : undefined, position: 'relative' }}
                className={isSelected ? 'selected' : ''}
              >
                <td style={{ position: 'relative' }}>
                  <div
                    className="row-bar bg-only"
                    style={{ width: `${pct}%` }}
                  />
                  <span style={{ position: 'relative' }}>
                    {isModel ? (
                      <span className={`tag ${modelClass(r.key)}`}>
                        {modelShort(r.key)}
                      </span>
                    ) : (
                      r.key
                    )}
                  </span>
                </td>
                <td
                  className="cell-decomp"
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHover({
                      key: r.key,
                      row: r,
                      segments,
                      left: rect.left,
                      top: rect.top - 6,
                    });
                  }}
                  onMouseLeave={() =>
                    setHover((h) => (h?.key === r.key ? null : h))
                  }
                >
                  <DecompBar segments={segments} width={frac} />
                </td>
                <td>
                  <span className="cost">{fmtMoney(r.totals.cost)}</span>
                </td>
                <td className="muted">{fmtInt(r.totals.count)}</td>
                <td className="muted">{fmtTokens(r.totals.total)}</td>
                <td className="muted">{pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > visible.length && (
        <div className="show-more">
          <button onClick={() => setShowAll(true)}>
            Show all {sorted.length}
          </button>
        </div>
      )}
      {hover && (
        <ShapePopover
          hover={hover}
          isModel={isModel}
          decomposeBy={decomposeBy}
        />
      )}
    </div>
  );
}

type HoverState = {
  key: string;
  row: Row;
  segments: Segment[];
  left: number;
  top: number;
};

// Token-type segments live here; model-family segments derive their label
// and color from the shared families.ts source of truth via `segMeta`.
const TYPE_META: Record<string, { label: string; color: string }> = {
  input: { label: 'Input', color: 'var(--tok-input)' },
  output: { label: 'Output', color: 'var(--tok-output)' },
  cwrite: { label: 'Cache write', color: 'var(--tok-cwrite)' },
  cread: { label: 'Cache read', color: 'var(--tok-cread)' },
};

function segMeta(cls: Segment['cls']): { label: string; color: string } {
  return TYPE_META[cls] ?? familyByKey(cls);
}

/**
 * Hover popover that spells out a row's shape — each segment with its value
 * and share. Positioned `fixed` from the cell's rect so it never clips
 * against the panel's borders. Segment values are tokens for the token-type
 * split and cost for the model split.
 */
function ShapePopover({
  hover,
  isModel,
  decomposeBy,
}: {
  hover: HoverState;
  isModel?: boolean;
  decomposeBy: 'type' | 'model';
}) {
  const total = hover.segments.reduce((s, x) => s + x.value, 0);
  const fmtVal = decomposeBy === 'type' ? fmtTokens : fmtMoney;
  return (
    <div
      className="chart-tooltip"
      style={{
        position: 'fixed',
        left: hover.left,
        top: hover.top,
        transform: 'translateY(-100%)',
        zIndex: 1000,
      }}
    >
      <div className="title">
        {isModel ? modelShort(hover.key) : hover.key}
      </div>
      <div className="total">{fmtVal(total)}</div>
      {hover.segments.map((s, i) => {
        const share = total > 0 ? (s.value / total) * 100 : 0;
        return (
          <div className="row" key={i}>
            <span>
              <span className="swatch" style={{ background: segMeta(s.cls).color }} />
              {segMeta(s.cls).label}
            </span>
            <span>
              {fmtVal(s.value)}
              <span className="muted" style={{ marginLeft: 6 }}>
                {share.toFixed(0)}%
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function computeSegments(r: Row, decomposeBy: 'type' | 'model'): Segment[] {
  if (decomposeBy === 'type') {
    const t = r.totals;
    return [
      { cls: 'input', value: t.input },
      { cls: 'output', value: t.output },
      { cls: 'cwrite', value: t.cacheWrite },
      { cls: 'cread', value: t.cacheRead },
    ];
  }
  // Split row's entries by model family, weighted by cost (so visually it
  // matches "where the money went" not "how many requests").
  const byFam = new Map<Segment['cls'], number>();
  for (let i = 0; i < r.entries.length; i++) {
    const e = r.entries[i]!;
    const cls = familyOf(e.m).key;
    byFam.set(cls, (byFam.get(cls) ?? 0) + costForEntry(e));
  }
  const out: Segment[] = [];
  for (const fam of [...FAMILIES, OTHER]) {
    const v = byFam.get(fam.key);
    if (v != null && v > 0) out.push({ cls: fam.key, value: v });
  }
  return out;
}
