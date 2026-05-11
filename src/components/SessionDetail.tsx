import { useEffect, useMemo } from 'react';
import type { SessionInfo } from '../aggregate';
import type { Entry } from '../types';
import { costForEntry } from '../pricing';
import { fmtInt, fmtMoney, fmtTokens, modelClass, modelShort } from '../format';

/**
 * Per-session drill-down. Lists every billed API call in the session in
 * chronological order with its individual cost + token breakdown. Sources
 * its entries by filtering the full unfiltered dataset by sessionId, so
 * drill-down is independent of dashboard filters (you see the whole
 * conversation, not just the slice that matched).
 */
export function SessionDetail({
  session,
  allEntries,
  onClose,
}: {
  session: SessionInfo;
  allEntries: Entry[];
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (let i = 0; i < allEntries.length; i++) {
      const e = allEntries[i]!;
      if (e.s === session.s) out.push(e);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }, [allEntries, session.s]);

  const label = session.title || session.firstPrompt || '(untitled session)';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              className="modal-title"
              title={label}
              style={{
                fontStyle: session.title ? 'normal' : 'italic',
                color: session.title ? 'var(--t-1)' : 'var(--t-2)',
              }}
            >
              {label}
            </div>
            <div className="modal-sub muted">
              {session.project} ·{' '}
              <span style={{ fontFamily: 'var(--mono)' }}>{session.s}</span>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal-stats">
          <Stat label="Calls" value={fmtInt(session.totals.count)} />
          <Stat label="Tokens" value={fmtTokens(session.totals.total)} />
          <Stat label="Input" value={fmtTokens(session.totals.input)} />
          <Stat label="Output" value={fmtTokens(session.totals.output)} />
          <Stat label="Cache write" value={fmtTokens(session.totals.cacheWrite)} />
          <Stat label="Cache read" value={fmtTokens(session.totals.cacheRead)} />
          <Stat label="Cost" value={fmtMoney(session.totals.cost)} emphasize />
        </div>

        {session.firstPrompt && (
          <div className="modal-prompt">
            <div className="modal-prompt-label muted">First prompt</div>
            <div className="modal-prompt-text">{session.firstPrompt}</div>
          </div>
        )}

        <div className="modal-body">
          <table className="modal-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Model</th>
                <th style={{ textAlign: 'right' }}>Input</th>
                <th style={{ textAlign: 'right' }}>Output</th>
                <th style={{ textAlign: 'right' }}>Cache wr</th>
                <th style={{ textAlign: 'right' }}>Cache rd</th>
                <th style={{ textAlign: 'right' }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const c = costForEntry(e);
                return (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {fmtTime(e.t)}
                    </td>
                    <td>
                      <span className={`tag ${modelClass(e.m)}`} style={{ fontSize: 10, padding: '0 4px' }}>
                        {modelShort(e.m)}
                      </span>
                      {e.f === 1 && (
                        <span className="muted" style={{ marginLeft: 4, fontSize: 10 }}>fast</span>
                      )}
                    </td>
                    <td className="muted" style={{ textAlign: 'right' }}>{fmtTokens(e.i)}</td>
                    <td className="muted" style={{ textAlign: 'right' }}>{fmtTokens(e.o)}</td>
                    <td className="muted" style={{ textAlign: 'right' }}>{fmtTokens(e.cc)}</td>
                    <td className="muted" style={{ textAlign: 'right' }}>{fmtTokens(e.cr)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="cost">{fmtMoney(c)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="modal-stat">
      <div className="muted modal-stat-label">{label}</div>
      <div className={emphasize ? 'modal-stat-value cost' : 'modal-stat-value'}>{value}</div>
    </div>
  );
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}
