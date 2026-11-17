/**
 * Usage report behind `tokens-gone report`: filters the scanned entries and
 * groups them by session, project, model or local day.
 *
 * Costs come from `costBreakdownForEntry`, the per-request pricing the
 * dashboard's rollup sums, so the report and the dashboard agree.
 */

import { costBreakdownForEntry } from './pricing.ts';
import type { ProviderId } from './providers/types.ts';
import type { Entry, SessionMeta } from './types.ts';

export const GROUP_BYS = ['session', 'project', 'model', 'day'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const PROVIDER_IDS: readonly ProviderId[] = ['cc', 'codex', 'opencode', 'pi', 'omp'];

export type ReportOptions = {
  groupBy: GroupBy;
  /** Inclusive lower bound, ms since epoch. */
  since?: number;
  /** Exclusive upper bound, ms since epoch. */
  until?: number;
  /** Case-insensitive substrings of the session's cwd (project name when the cwd is unknown); any match keeps the entry. */
  projects: string[];
  /** Empty keeps every provider. */
  providers: ProviderId[];
};

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type CostUsd = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type Usage = {
  /** ISO time of the first request. */
  firstAt: string;
  /** ISO time of the last request. */
  lastAt: string;
  requests: number;
  models: string[];
  tokens: TokenCounts;
  costUsd: CostUsd;
};

export type SubagentRow = Usage & {
  /** Claude Code agent id, or the child session id for providers that log subagents as sessions. */
  id: string;
  label: string | null;
};

export type SessionRow = Usage & {
  provider: ProviderId;
  sessionId: string;
  project: string;
  cwd: string | null;
  title: string | null;
  /** Usage of subagent transcripts, already included in the session's own totals. */
  subagents: SubagentRow[];
};

export type ProjectRow = Usage & { project: string; sessions: number };
export type ModelRow = Usage & { model: string; sessions: number };
export type DayRow = Usage & { day: string; sessions: number };

export type ReportRow = SessionRow | ProjectRow | ModelRow | DayRow;

export type ReportTotals = Omit<Usage, 'firstAt' | 'lastAt'> & {
  /** Null when no request matched. */
  firstAt: string | null;
  lastAt: string | null;
  sessions: number;
};

export type Report = {
  groupBy: GroupBy;
  since: string | null;
  until: string | null;
  rows: ReportRow[];
  totals: ReportTotals;
};

type Acc = {
  firstAt: number;
  lastAt: number;
  requests: number;
  models: Set<string>;
  tokens: TokenCounts;
  costUsd: CostUsd;
};

function emptyAcc(): Acc {
  return {
    firstAt: Infinity,
    lastAt: -Infinity,
    requests: 0,
    models: new Set(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type PricedEntry = { e: Entry; input: number; output: number; cacheRead: number; cacheWrite: number };

function add(acc: Acc, p: PricedEntry): void {
  const { e } = p;
  if (e.t < acc.firstAt) acc.firstAt = e.t;
  if (e.t > acc.lastAt) acc.lastAt = e.t;
  acc.requests++;
  acc.models.add(e.m);
  acc.tokens.input += e.i;
  acc.tokens.output += e.o;
  acc.tokens.cacheRead += e.cr;
  acc.tokens.cacheWrite += e.cc;
  acc.tokens.total += e.i + e.o + e.cr + e.cc;
  acc.costUsd.input += p.input;
  acc.costUsd.output += p.output;
  acc.costUsd.cacheRead += p.cacheRead;
  acc.costUsd.cacheWrite += p.cacheWrite;
  acc.costUsd.total += p.input + p.output + p.cacheRead + p.cacheWrite;
}

/** Micro-dollars: enough to sum rows back to the total without float noise in the output. */
function usd(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function usage(acc: Acc): Usage {
  return {
    firstAt: new Date(acc.firstAt).toISOString(),
    lastAt: new Date(acc.lastAt).toISOString(),
    requests: acc.requests,
    models: [...acc.models].sort(),
    tokens: { ...acc.tokens },
    costUsd: {
      input: usd(acc.costUsd.input),
      output: usd(acc.costUsd.output),
      cacheRead: usd(acc.costUsd.cacheRead),
      cacheWrite: usd(acc.costUsd.cacheWrite),
      total: usd(acc.costUsd.total),
    },
  };
}

/** Local calendar day, `YYYY-MM-DD`. */
export function localDay(t: number): string {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The session a subagent session rolls up into. Only sessions the provider
 * marks as subagents are folded; forks keep their own row, as on the dashboard.
 */
function rootSession(sessionId: string, meta: Record<string, SessionMeta>): string {
  let current = sessionId;
  const seen = new Set<string>([current]);
  for (;;) {
    const m = meta[current];
    const parent = m?.threadSource === 'subagent' ? m.parentSessionId : undefined;
    if (!parent || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

function subagentLabel(m: SessionMeta | undefined): string | null {
  return m?.agentNickname ?? m?.agentRole ?? m?.summary ?? null;
}

type SessionAcc = {
  acc: Acc;
  provider: ProviderId;
  project: string;
  /** Project of the root session's own entries, preferred over a subagent's. */
  ownProject: boolean;
  subagents: Map<string, Acc>;
};

export function buildReport(
  entries: Iterable<Entry>,
  sessionMeta: Record<string, SessionMeta>,
  options: ReportOptions,
): Report {
  const providers = new Set(options.providers);
  const needles = options.projects.map((p) => p.toLowerCase());
  const roots = new Map<string, string>();
  const rootOf = (sessionId: string): string => {
    let root = roots.get(sessionId);
    if (root === undefined) {
      root = rootSession(sessionId, sessionMeta);
      roots.set(sessionId, root);
    }
    return root;
  };
  const matchesProject = (e: Entry, root: string): boolean => {
    if (needles.length === 0) return true;
    const where = (sessionMeta[e.s]?.cwd ?? sessionMeta[root]?.cwd ?? e.p).toLowerCase();
    return needles.some((n) => where.includes(n));
  };

  const totals = emptyAcc();
  const allSessions = new Set<string>();
  const sessions = new Map<string, SessionAcc>();
  const groups = new Map<string, { acc: Acc; sessions: Set<string> }>();

  for (const e of entries) {
    if (options.since !== undefined && e.t < options.since) continue;
    if (options.until !== undefined && e.t >= options.until) continue;
    const provider = e.src ?? 'cc';
    if (providers.size > 0 && !providers.has(provider)) continue;
    const root = rootOf(e.s);
    if (!matchesProject(e, root)) continue;

    const priced: PricedEntry = { e, ...costBreakdownForEntry(e) };
    add(totals, priced);
    allSessions.add(root);

    if (options.groupBy === 'session') {
      let s = sessions.get(root);
      if (!s) {
        s = { acc: emptyAcc(), provider, project: e.p, ownProject: e.s === root, subagents: new Map() };
        sessions.set(root, s);
      } else if (!s.ownProject && e.s === root) {
        s.project = e.p;
        s.ownProject = true;
      }
      add(s.acc, priced);
      const subagent = e.s !== root ? e.s : e.a;
      if (subagent !== undefined) {
        let sub = s.subagents.get(subagent);
        if (!sub) {
          sub = emptyAcc();
          s.subagents.set(subagent, sub);
        }
        add(sub, priced);
      }
      continue;
    }

    const key = options.groupBy === 'project' ? e.p : options.groupBy === 'model' ? e.m : localDay(e.t);
    let g = groups.get(key);
    if (!g) {
      g = { acc: emptyAcc(), sessions: new Set() };
      groups.set(key, g);
    }
    add(g.acc, priced);
    g.sessions.add(root);
  }

  let rows: ReportRow[];
  if (options.groupBy === 'session') {
    const sessionRows: SessionRow[] = [];
    for (const [sessionId, s] of sessions) {
      const meta = sessionMeta[sessionId];
      const subagents: SubagentRow[] = [];
      for (const [id, acc] of s.subagents) {
        subagents.push({ id, label: subagentLabel(sessionMeta[id]), ...usage(acc) });
      }
      subagents.sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.id.localeCompare(b.id));
      sessionRows.push({
        provider: s.provider,
        sessionId,
        project: s.project,
        cwd: meta?.cwd ?? null,
        title: meta?.summary ?? meta?.firstPrompt ?? null,
        ...usage(s.acc),
        subagents,
      });
    }
    sessionRows.sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.sessionId.localeCompare(b.sessionId));
    rows = sessionRows;
  } else {
    const keyed = [...groups].map(([key, g]) => ({ key, usage: usage(g.acc), sessions: g.sessions.size }));
    if (options.groupBy === 'day') {
      keyed.sort((a, b) => a.key.localeCompare(b.key));
    } else {
      keyed.sort((a, b) => b.usage.costUsd.total - a.usage.costUsd.total || a.key.localeCompare(b.key));
    }
    rows = keyed.map(({ key, usage: u, sessions: n }): ReportRow => {
      if (options.groupBy === 'project') return { project: key, sessions: n, ...u };
      if (options.groupBy === 'model') return { model: key, sessions: n, ...u };
      return { day: key, sessions: n, ...u };
    });
  }

  return {
    groupBy: options.groupBy,
    since: options.since === undefined ? null : new Date(options.since).toISOString(),
    until: options.until === undefined ? null : new Date(options.until).toISOString(),
    rows,
    totals: totals.requests > 0
      ? { ...usage(totals), sessions: allSessions.size }
      : {
          firstAt: null,
          lastAt: null,
          requests: 0,
          models: [],
          tokens: { ...totals.tokens },
          costUsd: { ...totals.costUsd },
          sessions: 0,
        },
  };
}
