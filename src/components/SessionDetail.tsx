import { useEffect, useMemo, useState } from 'react';
import type {
  Entry,
  SessionTranscript,
  TranscriptEntry,
  TranscriptStream,
  TranscriptTokens,
} from '../types';
import type { SessionInfo } from '../aggregate';
import { costForEntry } from '../pricing';
import { fmtInt, fmtMoney, fmtTokens, modelClass, modelShort } from '../format';

type DetailView = 'log' | 'calls';

type TranscriptState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; data: SessionTranscript }
  | { status: 'refreshing'; data: SessionTranscript }
  | { status: 'error'; message: string; data?: SessionTranscript };

type TranscriptTreeNode = {
  id: string;
  label: string;
  meta: string;
  depth: 0 | 1 | 2;
  disabled?: boolean;
};

type TranscriptSlice = {
  stream: TranscriptStream;
  entries: TranscriptEntry[];
  label?: string;
  meta?: string;
};

type TranscriptNavigation = {
  nodes: TranscriptTreeNode[];
  slicesByNode: Map<string, TranscriptSlice[]>;
};

/**
 * Per-session drill-down. The cost-call table is still sourced from the
 * already-loaded aggregate entries, while the full transcript is fetched
 * lazily from raw JSONL only when this modal opens.
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
  const [view, setView] = useState<DetailView>('log');
  const [transcriptState, setTranscriptState] = useState<TranscriptState>({ status: 'idle' });
  const [transcriptRefreshKey, setTranscriptRefreshKey] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setView('log');
    setTranscriptState({ status: 'idle' });
    setTranscriptRefreshKey(0);
  }, [session.s]);

  useEffect(() => {
    if (view !== 'log') return;

    const ac = new AbortController();
    setTranscriptState((current) => {
      const data = transcriptData(current);
      return data ? { status: 'refreshing', data } : { status: 'loading' };
    });
    fetch(`/api/session-transcript?session=${encodeURIComponent(session.s)}`, {
      signal: ac.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          let message = `${r.status} ${r.statusText}`;
          try {
            const body: unknown = await r.json();
            message = errorMessage(body) ?? message;
          } catch {
            // Response was not JSON; keep the status text.
          }
          throw new Error(message);
        }
        const body: SessionTranscript = await r.json();
        setTranscriptState({ status: 'loaded', data: body });
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        setTranscriptState((current) => {
          const data = transcriptData(current);
          return data ? { status: 'error', message, data } : { status: 'error', message };
        });
      });

    return () => ac.abort();
  }, [session.s, view, transcriptRefreshKey]);

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
  const transcript = transcriptData(transcriptState);
  const subagentStreams = transcript
    ? transcript.streams.filter((stream) => stream.kind === 'subagent').length
    : 0;
  const transcriptBusy =
    transcriptState.status === 'loading' || transcriptState.status === 'refreshing';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <div className="modal-title-wrap">
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

        <div className="modal-tabs">
          <div className="seg-switch" role="group" aria-label="Session detail view">
            <button
              type="button"
              aria-pressed={view === 'log'}
              onClick={() => setView('log')}
            >
              Log
            </button>
            <button
              type="button"
              aria-pressed={view === 'calls'}
              onClick={() => setView('calls')}
            >
              Cost calls
            </button>
          </div>
          <div className="modal-tab-actions">
            <span className="modal-tab-meta">
              {transcriptState.status === 'refreshing'
                ? 'refreshing transcript...'
                : transcript
                  ? `${fmtInt(transcript.totalEntries)} log events · ${providerLabel(transcript.provider)} · ${subagentStreams} subagent streams`
                  : 'raw transcript loads on demand'}
            </span>
            {view === 'log' && (
              <button
                type="button"
                className="modal-refresh"
                onClick={() => setTranscriptRefreshKey((key) => key + 1)}
                disabled={transcriptBusy}
              >
                {transcriptState.status === 'refreshing' ? 'Refreshing' : 'Refresh'}
              </button>
            )}
          </div>
        </div>

        <div className="modal-body">
          {view === 'log' ? (
            <TranscriptLog state={transcriptState} />
          ) : (
            <CallsTable entries={entries} />
          )}
        </div>
      </div>
    </div>
  );
}

function transcriptData(state: TranscriptState): SessionTranscript | null {
  if (state.status === 'loaded' || state.status === 'refreshing') return state.data;
  if (state.status === 'error' && state.data) return state.data;
  return null;
}

function emptyNavigation(): TranscriptNavigation {
  return {
    nodes: [],
    slicesByNode: new Map(),
  };
}

function buildTranscriptNavigation(data: SessionTranscript): TranscriptNavigation {
  const nodes: TranscriptTreeNode[] = [];
  const slicesByNode = new Map<string, TranscriptSlice[]>();
  const mainStreams = data.streams.filter((stream) => stream.kind === 'main');
  const subagentStreams = data.streams.filter((stream) => stream.kind === 'subagent');

  slicesByNode.set('all', slicesForStreams(data.streams));
  nodes.push({
    id: 'all',
    label: 'All transcript',
    meta: `${fmtInt(data.totalEntries)} events`,
    depth: 0,
  });

  addGroup({
    nodes,
    slicesByNode,
    id: 'main',
    label: 'Main agent',
    streams: mainStreams,
  });

  addGroup({
    nodes,
    slicesByNode,
    id: 'subagents',
    label: 'Subagents',
    streams: subagentStreams,
  });

  return { nodes, slicesByNode };
}

function addGroup({
  nodes,
  slicesByNode,
  id,
  label,
  streams,
}: {
  nodes: TranscriptTreeNode[];
  slicesByNode: Map<string, TranscriptSlice[]>;
  id: string;
  label: string;
  streams: TranscriptStream[];
}) {
  const eventCount = countStreamEntries(streams);
  const compactCount = countCompactions(streams);
  slicesByNode.set(id, slicesForStreams(streams));
  nodes.push({
    id,
    label,
    meta: branchMeta(streams.length, eventCount, compactCount),
    depth: 0,
    disabled: streams.length === 0,
  });

  for (const stream of streams) {
    const streamId = `stream:${stream.id}`;
    const compactInStream = stream.entries.filter((entry) => entry.isCompactSummary).length;
    slicesByNode.set(streamId, [{ stream, entries: stream.entries }]);
    nodes.push({
      id: streamId,
      label: stream.kind === 'main' ? 'Session log' : subagentLabel(stream.label),
      meta: branchMeta(1, stream.entries.length, compactInStream),
      depth: 1,
    });

    for (const segment of streamSegments(stream)) {
      slicesByNode.set(segment.id, [{
        stream,
        entries: segment.entries,
        label: segment.label,
        meta: `${stream.path} · ${segment.meta}`,
      }]);
      nodes.push({
        id: segment.id,
        label: segment.label,
        meta: segment.meta,
        depth: 2,
      });
    }
  }
}

function slicesForStreams(streams: TranscriptStream[]): TranscriptSlice[] {
  return streams.map((stream) => ({ stream, entries: stream.entries }));
}

function countStreamEntries(streams: TranscriptStream[]): number {
  let count = 0;
  for (const stream of streams) count += stream.entries.length;
  return count;
}

function countCompactions(streams: TranscriptStream[]): number {
  let count = 0;
  for (const stream of streams) {
    for (const entry of stream.entries) {
      if (entry.isCompactSummary) count++;
    }
  }
  return count;
}

function branchMeta(streams: number, events: number, compactions: number): string {
  const parts = [`${fmtInt(events)} events`];
  if (streams !== 1) parts.push(`${fmtInt(streams)} streams`);
  if (compactions > 0) parts.push(`${fmtInt(compactions)} compactions`);
  return parts.join(' · ');
}

type TranscriptSegment = {
  id: string;
  label: string;
  meta: string;
  entries: TranscriptEntry[];
};

function streamSegments(stream: TranscriptStream): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let start = 0;
  let nextLabel = 'Initial context';
  let compactCount = 0;

  for (let i = 0; i < stream.entries.length; i++) {
    const entry = stream.entries[i]!;
    if (!entry.isCompactSummary) continue;
    if (i > start) {
      segments.push(segmentFromRange(stream, segments.length, start, i, nextLabel));
    }
    compactCount++;
    start = i + 1;
    nextLabel = `After compaction ${compactCount}`;
  }

  if (start < stream.entries.length) {
    const label = compactCount === 0 ? 'Full stream' : nextLabel;
    segments.push(segmentFromRange(stream, segments.length, start, stream.entries.length, label));
  }

  return segments;
}

function segmentFromRange(
  stream: TranscriptStream,
  index: number,
  start: number,
  end: number,
  label: string,
): TranscriptSegment {
  const entries = stream.entries.slice(start, end);
  const firstTime = entries[0]?.t;
  const lastTime = entries[entries.length - 1]?.t;
  return {
    id: `segment:${stream.id}:${index}`,
    label,
    meta: segmentMeta(entries.length, firstTime, lastTime),
    entries,
  };
}

function segmentMeta(events: number, firstTime: number | undefined, lastTime: number | undefined): string {
  const parts = [`${fmtInt(events)} events`];
  if (firstTime !== undefined && lastTime !== undefined) {
    parts.push(firstTime === lastTime ? fmtTime(firstTime) : `${fmtTime(firstTime)} to ${fmtTime(lastTime)}`);
  }
  return parts.join(' · ');
}

function subagentLabel(label: string): string {
  return label.startsWith('Subagent · ') ? label.slice('Subagent · '.length) : label;
}

function TranscriptLog({
  state,
}: {
  state: TranscriptState;
}) {
  const data = transcriptData(state);
  const navigation = useMemo(
    () => data ? buildTranscriptNavigation(data) : emptyNavigation(),
    [data],
  );
  const [selectedNodeId, setSelectedNodeId] = useState('all');

  useEffect(() => {
    setSelectedNodeId('all');
  }, [data?.sessionId]);

  if (state.status === 'idle' || state.status === 'loading') {
    return <div className="modal-log-state">Reading raw transcript…</div>;
  }

  if (state.status === 'error' && !data) {
    return (
      <div className="modal-log-state error">
        Transcript unavailable: {state.message}
      </div>
    );
  }

  if (!data) return null;
  const selectedSlices = navigation.slicesByNode.get(selectedNodeId)
    ?? navigation.slicesByNode.get('all')
    ?? [];
  const subagentStreams = data.streams.filter((stream) => stream.kind === 'subagent');

  if (data.missingRaw) {
    return (
      <div className="modal-log-state">
        Raw session JSONL is no longer on disk. The cached cost metadata still exists,
        but Claude Code may have swept the transcript via <code>cleanupPeriodDays</code>.
      </div>
    );
  }

  return (
    <div className="transcript">
      {state.status === 'error' && (
        <div className="transcript-notice error">
          Refresh failed: {state.message}
        </div>
      )}
      <div className="transcript-summary">
        <span className="modal-tab-meta">
          {fmtInt(data.sourceFiles)} files · {fmtInt(subagentStreams.length)} subagent streams
        </span>
      </div>

      <div className="transcript-layout">
        <nav className="transcript-tree" aria-label="Transcript tree">
          {navigation.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`tree-node depth-${node.depth}`}
              aria-current={selectedNodeId === node.id ? 'true' : undefined}
              disabled={node.disabled}
              onClick={() => setSelectedNodeId(node.id)}
            >
              <span className="tree-node-label">{node.label}</span>
              <span className="tree-node-meta">{node.meta}</span>
            </button>
          ))}
        </nav>

        <div className="transcript-streams">
          {selectedSlices.length === 0 ? (
            <div className="modal-log-state">No log events in this branch.</div>
          ) : (
            selectedSlices.map((slice) => (
              <TranscriptStreamView
                key={`${slice.stream.id}:${slice.label ?? 'all'}`}
                slice={slice}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptStreamView({ slice }: { slice: TranscriptSlice }) {
  const stream = slice.stream;
  const entries = slice.entries;
  return (
    <section className={`transcript-stream ${stream.kind}`}>
      <header className="transcript-stream-head">
        <div>
          <div className="transcript-stream-title">
            {slice.label ?? stream.label}
            {stream.kind === 'subagent' && <span className="log-badge">subagent</span>}
          </div>
          <div className="transcript-stream-path">{slice.meta ?? stream.path}</div>
        </div>
        <span className="modal-tab-meta">{fmtInt(entries.length)} events</span>
      </header>
      <div className="log-list">
        {entries.map((entry) => (
          <TranscriptEntryView key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  const hasFields = (entry.fields?.length ?? 0) > 0;
  const hasImages = (entry.images?.length ?? 0) > 0;
  const collapsible =
    entry.kind === 'tool_use' ||
    entry.kind === 'tool_result' ||
    entry.kind === 'progress' ||
    entry.kind === 'event' ||
    (entry.text?.length ?? 0) > 1200;
  const open = entry.kind !== 'tool_result' && entry.kind !== 'progress' && entry.kind !== 'event';

  return (
    <article className={`log-entry role-${entry.role} kind-${entry.kind}`}>
      <div className="log-rail">{roleShort(entry.role)}</div>
      <div className="log-entry-main">
        <div className="log-entry-head">
          <span className="log-time">{entry.t === undefined ? 'no time' : fmtTime(entry.t)}</span>
          <span className="log-title">{entry.title}</span>
          {entry.model && (
            <span className={`tag ${modelClass(entry.model)}`}>
              {modelShort(entry.model)}
            </span>
          )}
          {entry.isCompactSummary && <span className="log-badge compact">compaction</span>}
          {entry.isSidechain && <span className="log-badge">subagent</span>}
          <span className="log-raw">{entry.rawType}</span>
        </div>

        <TokenLine tokens={entry.tokens} />
        {entry.meta && <div className="log-meta">{entry.meta.join(' · ')}</div>}
        <EntryFields entry={entry} />
        <EntryImages entry={entry} />

        {entry.text && collapsible ? (
          <details className="log-details" open={open}>
            <summary>{entry.kind === 'tool_result' ? 'Tool output' : 'Payload'}</summary>
            <pre>{entry.text}</pre>
          </details>
        ) : entry.text ? (
          <pre className="log-text">{entry.text}</pre>
        ) : hasFields || hasImages ? null : (
          <div className="log-empty">No textual payload</div>
        )}
      </div>
    </article>
  );
}

function EntryFields({ entry }: { entry: TranscriptEntry }) {
  if (!entry.fields || entry.fields.length === 0) return null;
  return (
    <dl className="log-fields">
      {entry.fields.map((field) => (
        <div key={`${field.label}:${field.value}`} className="log-field">
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EntryImages({ entry }: { entry: TranscriptEntry }) {
  if (!entry.images || entry.images.length === 0) return null;
  return (
    <div className="log-images">
      {entry.images.map((image, index) => (
        <figure key={`${image.mediaType}:${index}`} className="log-image">
          <img
            src={`data:${image.mediaType};base64,${image.data}`}
            alt={image.label ?? `Image ${index + 1}`}
            loading="lazy"
          />
          <figcaption>
            <span>{image.label ?? `Image ${index + 1}`}</span>
            <span>{image.mediaType}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function CallsTable({ entries }: { entries: Entry[] }) {
  return (
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
  );
}

function TokenLine({ tokens }: { tokens?: TranscriptTokens }) {
  if (!tokens) return null;
  const parts: string[] = [];
  if (tokens.input !== undefined) parts.push(`in ${fmtTokens(tokens.input)}`);
  if (tokens.output !== undefined) parts.push(`out ${fmtTokens(tokens.output)}`);
  if (tokens.cacheWrite !== undefined) parts.push(`cw ${fmtTokens(tokens.cacheWrite)}`);
  if (tokens.cacheRead !== undefined) parts.push(`cr ${fmtTokens(tokens.cacheRead)}`);
  if (parts.length === 0) return null;
  return <div className="log-tokens">{parts.join(' · ')}</div>;
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

function providerLabel(provider: SessionTranscript['provider']): string {
  if (provider === 'cc') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  if (provider === 'pi') return 'Pi';
  return 'OpenCode';
}

function roleShort(role: TranscriptEntry['role']): string {
  if (role === 'user') return 'U';
  if (role === 'assistant') return 'A';
  if (role === 'system') return 'S';
  if (role === 'tool') return 'T';
  return 'E';
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value.error;
  return typeof error === 'string' ? error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
