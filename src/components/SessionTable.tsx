import { useMemo, useState } from 'react';
import type { SessionInfo } from '../aggregate';
import { fmtMoney, fmtRelativeDay, fmtTokens, modelClass, modelShort } from '../format';

type SortKey = 'lastSeen' | 'cost' | 'count' | 'duration' | 'total';

export function SessionTable({ sessions }: { sessions: SessionInfo[] }) {
  const [sort, setSort] = useState<SortKey>('lastSeen');
  const [asc, setAsc] = useState(false);
  const [limit, setLimit] = useState(50);

  const sorted = useMemo(() => {
    const copy = [...sessions];
    copy.sort((a, b) => {
      let va: number;
      let vb: number;
      if (sort === 'lastSeen') {
        va = a.lastSeen;
        vb = b.lastSeen;
      } else if (sort === 'duration') {
        va = a.lastSeen - a.firstSeen;
        vb = b.lastSeen - b.firstSeen;
      } else if (sort === 'cost') {
        va = a.totals.cost;
        vb = b.totals.cost;
      } else if (sort === 'count') {
        va = a.totals.count;
        vb = b.totals.count;
      } else {
        va = a.totals.total;
        vb = b.totals.total;
      }
      return asc ? va - vb : vb - va;
    });
    return copy;
  }, [sessions, sort, asc]);

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

  const visible = sorted.slice(0, limit);

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Sessions</h2>
        <div className="spacer" />
        <span className="muted">
          {sessions.length} total, showing {visible.length}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Project</th>
            <th style={{ textAlign: 'left' }}>Models</th>
            {header('lastSeen', 'Last')}
            {header('duration', 'Duration')}
            {header('count', 'Reqs')}
            {header('total', 'Tokens')}
            {header('cost', 'Cost')}
            <th style={{ textAlign: 'left' }}>Session</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((s) => (
            <tr key={s.s}>
              <td>{s.project}</td>
              <td>
                {s.models.map((m) => (
                  <span key={m} className={`tag ${modelClass(m)}`} style={{ marginRight: 4 }}>
                    {modelShort(m)}
                  </span>
                ))}
              </td>
              <td>{fmtRelativeDay(s.lastSeen)}</td>
              <td>{fmtDuration(s.lastSeen - s.firstSeen)}</td>
              <td>{s.totals.count}</td>
              <td>{fmtTokens(s.totals.total)}</td>
              <td>{fmtMoney(s.totals.cost)}</td>
              <td className="muted">{s.s.slice(0, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > limit && (
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <button onClick={() => setLimit(limit + 50)}>Show more</button>
        </div>
      )}
    </div>
  );
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `${(ms / 3600_000).toFixed(1)}h`;
  return `${(ms / 86400_000).toFixed(1)}d`;
}
