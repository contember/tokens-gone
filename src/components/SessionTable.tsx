import { useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SessionInfo, Totals } from '../aggregate';
import { HARNESS_LABELS, type Harness } from '../types';
import { fmtInt, fmtMoney, fmtRelativeDay, fmtTokens, modelClass, modelShort } from '../format';

type SortKey = 'lastSeen' | 'cost' | 'count' | 'duration' | 'total';

type SessionGroup = {
  id: string;
  parentId: string;
  sessions: SessionInfo[];
  totals: Totals;
  models: string[];
  project: string;
  firstSeen: number;
  lastSeen: number;
  label: string;
};

type TableItem =
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'group'; group: SessionGroup };

type VisibleRow =
  | { kind: 'session'; session: SessionInfo; depth: 0 | 1 }
  | { kind: 'group'; group: SessionGroup };

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => groupMultiAgentSessions(sessions), [sessions]);

  const sorted = useMemo(() => {
    const copy = [...grouped];
    copy.sort((a, b) => {
      const av = itemValues(a);
      const bv = itemValues(b);
      let va: number, vb: number;
      switch (sort) {
        case 'lastSeen':
          va = av.lastSeen; vb = bv.lastSeen; break;
        case 'duration':
          va = av.lastSeen - av.firstSeen; vb = bv.lastSeen - bv.firstSeen; break;
        case 'cost':
          va = av.totals.cost; vb = bv.totals.cost; break;
        case 'count':
          va = av.totals.count; vb = bv.totals.count; break;
        default:
          va = av.totals.total; vb = bv.totals.total;
      }
      return asc ? va - vb : vb - va;
    });
    return copy;
  }, [grouped, sort, asc]);

  const rows = useMemo(() => visibleRows(sorted, expandedGroups), [sorted, expandedGroups]);

  const maxCost = useMemo(
    () => sorted.reduce((m, item) => Math.max(m, itemValues(item).totals.cost), 0),
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

  const visible = rows.slice(0, limit);
  const groupCount = grouped.filter((item) => item.kind === 'group').length;

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
          {fmtInt(sessions.length)} sessions · {fmtInt(groupCount)} groups · showing {visible.length}
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
          {visible.map((row) => row.kind === 'group' ? (
            <GroupRow
              key={row.group.id}
              group={row.group}
              maxCost={maxCost}
              expanded={expandedGroups.has(row.group.id)}
              onToggle={() => toggleGroup(row.group.id, setExpandedGroups)}
            />
          ) : (
            <SessionRow
              key={`${row.depth}:${row.session.s}`}
              session={row.session}
              depth={row.depth}
              maxCost={maxCost}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <div className="show-more">
          <button onClick={() => setLimit(limit + 50)}>
            Show {Math.min(50, rows.length - limit)} more
          </button>
        </div>
      )}
    </div>
  );
}

function GroupRow({
  group,
  maxCost,
  expanded,
  onToggle,
}: {
  group: SessionGroup;
  maxCost: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const pct = maxCost > 0 ? (group.totals.cost / maxCost) * 100 : 0;
  return (
    <tr
      className="clickable session-group-row"
      onClick={onToggle}
      style={{ position: 'relative' }}
    >
      <td style={{ position: 'relative', maxWidth: 360 }}>
        <div className="row-bar bg-only" style={{ width: `${pct}%` }} />
        <div className="session-row-main">
          <div className="session-title" title={group.label}>
            <span className="session-disclosure">{expanded ? '-' : '+'}</span>
            {group.label}
          </div>
          <div className="muted session-row-meta">
            {group.parentId.slice(0, 8)} · {fmtInt(group.sessions.length)} sessions
          </div>
        </div>
      </td>
      <td style={{ position: 'relative' }}>
        <ProjectModels project={group.project} models={group.models} extra="multi-agent run" />
      </td>
      <td className="muted">{fmtRelativeDay(group.lastSeen)}</td>
      <td className="muted">{fmtDuration(group.lastSeen - group.firstSeen)}</td>
      <td className="muted">{fmtInt(group.totals.count)}</td>
      <td className="muted">{fmtTokens(group.totals.total)}</td>
      <td><span className="cost">{fmtMoney(group.totals.cost)}</span></td>
    </tr>
  );
}

function SessionRow({
  session,
  depth,
  maxCost,
  onSelect,
}: {
  session: SessionInfo;
  depth: 0 | 1;
  maxCost: number;
  onSelect: (s: SessionInfo) => void;
}) {
  const pct = maxCost > 0 ? (session.totals.cost / maxCost) * 100 : 0;
  const label = sessionLabel(session);
  return (
    <tr
      className={depth === 1 ? 'clickable session-child-row' : 'clickable'}
      onClick={() => onSelect(session)}
      style={{ position: 'relative' }}
    >
      <td style={{ position: 'relative', maxWidth: 360 }}>
        <div className="row-bar bg-only" style={{ width: `${pct}%` }} />
        <div className="session-row-main">
          <div
            className="session-title"
            title={label}
            style={{
              color: session.title ? 'var(--t-1)' : 'var(--t-2)',
              fontStyle: session.title ? 'normal' : 'italic',
            }}
          >
            {depth === 1 && <span className="session-child-prefix">sub</span>}
            {session.agentNickname ? `${session.agentNickname} · ${label}` : label}
          </div>
          <div className="muted session-row-meta">
            {session.s.slice(0, 8)}
          </div>
        </div>
      </td>
      <td style={{ position: 'relative' }}>
        <ProjectModels project={session.project} models={session.models} />
      </td>
      <td className="muted">{fmtRelativeDay(session.lastSeen)}</td>
      <td className="muted">{fmtDuration(session.lastSeen - session.firstSeen)}</td>
      <td className="muted">{fmtInt(session.totals.count)}</td>
      <td className="muted">{fmtTokens(session.totals.total)}</td>
      <td><span className="cost">{fmtMoney(session.totals.cost)}</span></td>
    </tr>
  );
}

function ProjectModels({
  project,
  models,
  extra,
}: {
  project: string;
  models: string[];
  extra?: string;
}) {
  return (
    <div className="session-project-models">
      <span style={{ color: 'var(--t-1)' }}>{project}</span>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        {models.map((m) => (
          <span key={m} className={`tag ${modelClass(m)}`} style={{ fontSize: 10, padding: '0 4px' }}>
            {modelShort(m)}
          </span>
        ))}
      </span>
      {extra && <span className="log-badge">{extra}</span>}
    </div>
  );
}

function toggleGroup(
  id: string,
  setExpandedGroups: Dispatch<SetStateAction<Set<string>>>,
): void {
  setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

function groupMultiAgentSessions(sessions: SessionInfo[]): TableItem[] {
  const byId = new Map<string, SessionInfo>();
  const childrenByParent = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    byId.set(session.s, session);
    if (session.src !== 'codex' && session.src !== 'opencode') continue;
    if (session.threadSource !== 'subagent') continue;
    if (!session.parentSessionId) continue;
    let bucket = childrenByParent.get(session.parentSessionId);
    if (!bucket) {
      bucket = [];
      childrenByParent.set(session.parentSessionId, bucket);
    }
    bucket.push(session);
  }

  const groupedIds = new Set<string>();
  const items: TableItem[] = [];
  for (const [parentId, children] of childrenByParent) {
    if (children.length < 2) continue;
    const parent = byId.get(parentId);
    const members = parent ? [parent, ...children] : [...children];
    members.sort((a, b) => a.firstSeen - b.firstSeen);
    for (const member of members) groupedIds.add(member.s);
    const harness = children[0]?.src ?? 'codex';
    items.push({ kind: 'group', group: sessionGroup(parentId, members, parent, harness) });
  }

  for (const session of sessions) {
    if (groupedIds.has(session.s)) continue;
    items.push({ kind: 'session', session });
  }
  return items;
}

function sessionGroup(
  parentId: string,
  sessions: SessionInfo[],
  parent: SessionInfo | undefined,
  harness: Harness,
): SessionGroup {
  const totals = combinedTotals(sessions);
  const models: string[] = [];
  const projects = new Set<string>();
  let firstSeen = Number.MAX_SAFE_INTEGER;
  let lastSeen = 0;
  for (const session of sessions) {
    projects.add(session.project);
    if (session.firstSeen < firstSeen) firstSeen = session.firstSeen;
    if (session.lastSeen > lastSeen) lastSeen = session.lastSeen;
    for (const model of session.models) {
      if (!models.includes(model)) models.push(model);
    }
  }
  return {
    id: `${harness}:${parentId}`,
    parentId,
    sessions,
    totals,
    models,
    project: projects.size === 1 ? sessions[0]?.project ?? 'unknown' : `${fmtInt(projects.size)} projects`,
    firstSeen,
    lastSeen,
    label: parent ? sessionLabel(parent) : `${HARNESS_LABELS[harness]} run ${parentId.slice(0, 8)}`,
  };
}

function combinedTotals(sessions: SessionInfo[]): Totals {
  const totals: Totals = {
    count: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    total: 0,
    cost: 0,
  };
  for (const session of sessions) {
    totals.count += session.totals.count;
    totals.input += session.totals.input;
    totals.output += session.totals.output;
    totals.cacheWrite += session.totals.cacheWrite;
    totals.cacheRead += session.totals.cacheRead;
    totals.total += session.totals.total;
    totals.cost += session.totals.cost;
  }
  return totals;
}

function itemValues(item: TableItem): {
  totals: Totals;
  firstSeen: number;
  lastSeen: number;
} {
  if (item.kind === 'group') {
    return {
      totals: item.group.totals,
      firstSeen: item.group.firstSeen,
      lastSeen: item.group.lastSeen,
    };
  }
  return {
    totals: item.session.totals,
    firstSeen: item.session.firstSeen,
    lastSeen: item.session.lastSeen,
  };
}

function visibleRows(items: TableItem[], expandedGroups: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const item of items) {
    if (item.kind === 'session') {
      rows.push({ kind: 'session', session: item.session, depth: 0 });
      continue;
    }
    rows.push({ kind: 'group', group: item.group });
    if (!expandedGroups.has(item.group.id)) continue;
    for (const session of item.group.sessions) {
      rows.push({ kind: 'session', session, depth: 1 });
    }
  }
  return rows;
}

function sessionLabel(session: SessionInfo): string {
  return session.title || session.firstPrompt || '(untitled)';
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `${(ms / 3600_000).toFixed(1)}h`;
  return `${(ms / 86400_000).toFixed(1)}d`;
}
