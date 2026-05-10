import { useMemo, useState } from 'react';
import type { Totals } from '../aggregate';
import { fmtInt, fmtMoney, fmtTokens, modelClass, modelShort } from '../format';

export type Row = {
  key: string;
  totals: Totals;
};

type SortKey = 'cost' | 'count' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total';

export function BreakdownTable({
  rows,
  title,
  keyLabel,
  isModel,
  onRowClick,
  selected,
}: {
  rows: Row[];
  title: string;
  keyLabel: string;
  isModel?: boolean;
  onRowClick?: (key: string) => void;
  selected?: Set<string>;
}) {
  const [sort, setSort] = useState<SortKey>('cost');
  const [asc, setAsc] = useState(false);

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

  function header(col: SortKey, label: string, alignLeft = false) {
    return (
      <th
        style={alignLeft ? { textAlign: 'left' } : undefined}
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
    <div className="panel">
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{keyLabel}</th>
            {header('cost', 'Cost')}
            {header('count', 'Reqs')}
            {header('input', 'In')}
            {header('output', 'Out')}
            {header('cacheWrite', 'C.Write')}
            {header('cacheRead', 'C.Read')}
            {header('total', 'Total')}
            <th>%</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const pct = grandTotal > 0 ? (r.totals.cost / grandTotal) * 100 : 0;
            const isSelected = selected?.has(r.key) ?? false;
            return (
              <tr
                key={r.key}
                onClick={onRowClick ? () => onRowClick(r.key) : undefined}
                style={{
                  cursor: onRowClick ? 'pointer' : undefined,
                  background: isSelected ? 'rgba(122, 162, 247, 0.1)' : undefined,
                }}
              >
                <td>
                  {isModel ? (
                    <span className={`tag ${modelClass(r.key)}`}>
                      {modelShort(r.key)}
                    </span>
                  ) : (
                    r.key
                  )}
                </td>
                <td>{fmtMoney(r.totals.cost)}</td>
                <td>{fmtInt(r.totals.count)}</td>
                <td>{fmtTokens(r.totals.input)}</td>
                <td>{fmtTokens(r.totals.output)}</td>
                <td>{fmtTokens(r.totals.cacheWrite)}</td>
                <td>{fmtTokens(r.totals.cacheRead)}</td>
                <td>{fmtTokens(r.totals.total)}</td>
                <td className="muted">{pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
