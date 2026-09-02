import { useEffect, useMemo, useState } from 'react';
import { fmtInt, fmtMoney, fmtTokens, modelClass, modelShort } from '../format';
import type { Filters, RankedRequest, RequestList, SessionMeta } from '../types';
import { HARNESS_LABELS, entryHarness } from '../types';

type RequestState =
  | { status: 'loading' }
  | { status: 'loaded'; data: RequestList }
  | { status: 'error'; message: string };

const REQUEST_LIMIT = 50;

export function RequestTable({
  filters,
  generatedAt,
  sessionMeta,
  onSelectSession,
}: {
  filters: Filters;
  generatedAt: number;
  sessionMeta: Record<string, SessionMeta>;
  onSelectSession: (sessionId: string) => void;
}) {
  const [state, setState] = useState<RequestState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(requestUrl(filters), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data: RequestList = await response.json();
        setState({ status: 'loaded', data });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [filters, generatedAt]);

  const maxCost = useMemo(() => {
    if (state.status !== 'loaded') return 0;
    let max = 0;
    for (const entry of state.data.entries) {
      if (entry.c > max) max = entry.c;
    }
    return max;
  }, [state]);

  return (
    <div>
      <div className="section-head">
        <h2>Most expensive requests</h2>
        <span className="meta">{requestMeta(state)}</span>
      </div>
      {state.status === 'loading' ? (
        <div className="empty">Ranking individual requests…</div>
      ) : state.status === 'error' ? (
        <div className="error">Could not load requests: {state.message}</div>
      ) : state.data.entries.length === 0 ? (
        <div className="empty">No requests in this range</div>
      ) : (
        <div className="request-table-wrap">
          <table className="request-table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Project · Harness</th>
                <th>Model</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cache wr</th>
                <th>Cache rd</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {state.data.entries.map((entry, index) => (
                <RequestRow
                  key={`${entry.s}:${entry.t}:${index}`}
                  entry={entry}
                  rank={index + 1}
                  maxCost={maxCost}
                  meta={sessionMeta[entry.s]}
                  onSelect={() => onSelectSession(entry.s)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RequestRow({
  entry,
  rank,
  maxCost,
  meta,
  onSelect,
}: {
  entry: RankedRequest;
  rank: number;
  maxCost: number;
  meta?: SessionMeta;
  onSelect: () => void;
}) {
  const label = meta?.summary || meta?.firstPrompt || `Session ${entry.s.slice(0, 8)}`;
  const share = maxCost > 0 ? (entry.c / maxCost) * 100 : 0;

  return (
    <tr
      className="clickable"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <td className="request-cell-main">
        <div className="row-bar bg-only" style={{ width: `${share}%` }} />
        <div className="request-main">
          <span className="request-rank">#{rank}</span>
          <span className="request-identity">
            <span className="request-title" title={`${label} · ${entry.s}`}>{label}</span>
            <span className="request-time">{fmtRequestTime(entry.t)}</span>
            <span className="request-mobile-meta">
              {entry.p} · {modelShort(entry.m)}{entry.f === 1 ? ' fast' : ''} ·{' '}
              {HARNESS_LABELS[entryHarness(entry)]}
            </span>
          </span>
        </div>
      </td>
      <td>
        <span className="request-project">{entry.p}</span>
        <span className="request-harness">{HARNESS_LABELS[entryHarness(entry)]}</span>
      </td>
      <td>
        <span className={`tag ${modelClass(entry.m)}`}>{modelShort(entry.m)}</span>
        {entry.f === 1 && <span className="request-fast">fast</span>}
      </td>
      <td className="muted">{fmtTokens(entry.i)}</td>
      <td className="muted">{fmtTokens(entry.o)}</td>
      <td className="muted">{fmtTokens(entry.cc)}</td>
      <td className="muted">{fmtTokens(entry.cr)}</td>
      <td><span className="cost">{fmtMoney(entry.c)}</span></td>
    </tr>
  );
}

function requestUrl(filters: Filters): string {
  const params = new URLSearchParams({ limit: String(REQUEST_LIMIT) });
  if (filters.from !== null) params.set('from', String(filters.from));
  if (filters.to !== null) params.set('to', String(filters.to));
  for (const project of filters.projects) params.append('project', project);
  for (const model of filters.models) params.append('model', model);
  for (const harness of filters.harnesses) params.append('harness', harness);
  return `/api/requests?${params}`;
}

function requestMeta(state: RequestState): string {
  if (state.status === 'loading') return 'reading raw request log';
  if (state.status === 'error') return 'request log unavailable';
  const shown = state.data.entries.length;
  return shown === state.data.total
    ? `${fmtInt(shown)} requests ranked by cost`
    : `${fmtInt(state.data.total)} matching · top ${fmtInt(shown)}`;
}

function fmtRequestTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
