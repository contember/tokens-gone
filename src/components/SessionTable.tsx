import { useMemo, useState } from 'react';
import type { SessionInfo } from '../aggregate';
import { fmtInt, fmtMoney, fmtRelativeDay, fmtTokens, modelClass, modelShort } from '../format';

type SortKey = 'lastSeen' | 'cost' | 'count' | 'duration' | 'total';

/**
 * Sessions as receipt-style rows. The auto-generated title from Claude's
 * sessions-index.json leads — that's the human-readable label visible in
 * `/resume`. Row click opens a per-call breakdown.
 */
export function SessionTable({
  sessions,
  onSelect,
}: {
  sessions: SessionInfo[];
  onSelect: (s: SessionInfo) => void;
}) {
  const [sort, setSort] = useState<SortKey>('lastSeen');
  const [asc, setAsc] = useState(false);
  const [limit, setLimit] = useState(40);

  const sorted = useMemo(() => {
    const copy = [...sessions];
    copy.sort((a, b) => {
      let va: number, vb: number;
      switch (sort) {
        case 'lastSeen':
          va = a.lastSeen; vb = b.lastSeen; break;
        case 'duration':
          va = a.lastSeen - a.firstSeen; vb = b.lastSeen - b.firstSeen; break;
        case 'cost':
          va = a.totals.cost; vb = b.totals.cost; break;
        case 'count':
          va = a.totals.count; vb = b.totals.count; break;
        default:
          va = a.totals.total; vb = b.totals.total;
      }
      return asc ? va - vb : vb - va;
    });
    return copy;
  }, [sessions, sort, asc]);

  const maxCost = useMemo(
    () => sorted.reduce((m, s) => Math.max(m, s.totals.cost), 0),
    [sorted],
  );

  function header(col: SortKey, label: string) {
    return (
      <th
        className={sort === col ? `sorted ${asc ? 'asc' : ''}` : ''}
        onClick={() => {
          if (sort === col) setAsc(!asc);
          else { setSort(col); setAsc(false); }
        }}
      >
        {label}
      </th>
    );
  }

  const visible = sorted.slice(0, limit);

  if (sessions.length === 0) {
    return (
      <div>
        <div className="section-head">
          <h2>Sessions</h2>
        </div>
        <div className="empty">No sessions in this range</div>
      </div>
    );
  }

  return (
    <div>
      <div className="section-head">
        <h2>Sessions</h2>
        <span className="meta">
          {fmtInt(sessions.length)} total · showing {visible.length}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Project · Models</th>
            {header('lastSeen', 'Last')}
            {header('duration', 'Duration')}
            {header('count', 'Reqs')}
            {header('total', 'Tokens')}
            {header('cost', 'Cost')}
          </tr>
        </thead>
        <tbody>
          {visible.map((s) => {
            const pct = maxCost > 0 ? (s.totals.cost / maxCost) * 100 : 0;
            const label = s.title || s.firstPrompt || '(untitled)';
            return (
              <tr
                key={s.s}
                className="clickable"
                onClick={() => onSelect(s)}
                style={{ position: 'relative' }}
              >
                <td style={{ position: 'relative', maxWidth: 360 }}>
                  <div className="row-bar bg-only" style={{ width: `${pct}%` }} />
                  <div style={{ position: 'relative' }}>
                    <div
                      className="session-title"
                      title={label}
                      style={{
                        color: s.title ? 'var(--t-1)' : 'var(--t-2)',
                        fontStyle: s.title ? 'normal' : 'italic',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {label}
                    </div>
                    <div
                      className="muted"
                      style={{ fontFamily: 'var(--mono)', fontSize: 10 }}
                    >
                      {s.s.slice(0, 8)}
                    </div>
                  </div>
                </td>
                <td style={{ position: 'relative' }}>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--t-1)' }}>{s.project}</span>
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {s.models.map((m) => (
                        <span key={m} className={`tag ${modelClass(m)}`} style={{ fontSize: 10, padding: '0 4px' }}>
                          {modelShort(m)}
                        </span>
                      ))}
                    </span>
                  </div>
                </td>
                <td className="muted">{fmtRelativeDay(s.lastSeen)}</td>
                <td className="muted">{fmtDuration(s.lastSeen - s.firstSeen)}</td>
                <td className="muted">{fmtInt(s.totals.count)}</td>
                <td className="muted">{fmtTokens(s.totals.total)}</td>
                <td><span className="cost">{fmtMoney(s.totals.cost)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > limit && (
        <div className="show-more">
          <button onClick={() => setLimit(limit + 50)}>
            Show {Math.min(50, sorted.length - limit)} more
          </button>
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
