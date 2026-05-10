import { useMemo, useState } from 'react';
import type { Entry } from '../types';
import type { Totals } from '../aggregate';
import { fmtInt, fmtMoney, fmtTokens, modelClass, modelShort } from '../format';
import { DecompBar, modelSegment, type Segment } from './DecompBar';
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
                <td className="cell-decomp">
                  <DecompBar segments={segments} />
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
    const cls = modelSegment(e.m);
    byFam.set(cls, (byFam.get(cls) ?? 0) + costForEntry(e));
  }
  const order: Segment['cls'][] = ['opus', 'sonnet', 'haiku', 'other'];
  const out: Segment[] = [];
  for (const k of order) {
    const v = byFam.get(k);
    if (v != null && v > 0) out.push({ cls: k, value: v });
  }
  return out;
}
