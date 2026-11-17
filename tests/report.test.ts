import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _scanClaude as scanClaude } from '../server/providers/claude';
import { flushCacheWrites } from '../server/providers/base';
import { costBreakdownForEntry } from '../server/pricing';
import { buildReport, type ReportOptions, type SessionRow } from '../server/report';
import { rollupEntries } from '../server/rollup';
import type { Entry, SessionMeta } from '../server/types';

let dir: string;
let projects: string;

let ids = 0;
function assistant(over: {
  timestamp: string;
  sessionId: string;
  cwd: string;
  model?: string;
  tokens: [number, number, number, number];
  sidechain?: string;
}): string {
  const n = ++ids;
  const [input, output, cacheWrite, cacheRead] = over.tokens;
  return JSON.stringify({
    type: 'assistant',
    timestamp: over.timestamp,
    sessionId: over.sessionId,
    cwd: over.cwd,
    requestId: `req-${n}`,
    ...(over.sidechain ? { isSidechain: true, agentId: over.sidechain } : {}),
    message: {
      id: `msg-${n}`,
      model: over.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

function user(sessionId: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-04-15T09:59:00Z',
    sessionId,
    cwd,
    message: { role: 'user', content: text },
  });
}

const APP = '/home/user/projects/app';
const LIB = '/home/user/work/lib';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tokens-gone-report-'));
  projects = join(dir, 'projects');
  const appDir = join(projects, '-home-user-projects-app');
  const libDir = join(projects, '-home-user-work-lib');
  await mkdir(join(appDir, 'sess-main', 'subagents'), { recursive: true });
  await mkdir(libDir, { recursive: true });

  await writeFile(
    join(appDir, 'sess-main.jsonl'),
    [
      user('sess-main', APP, 'Fix the login bug'),
      assistant({ timestamp: '2026-04-15T10:00:00Z', sessionId: 'sess-main', cwd: APP, tokens: [100, 200, 1000, 5000] }),
      assistant({
        timestamp: '2026-04-15T10:30:00Z',
        sessionId: 'sess-main',
        cwd: APP,
        model: 'claude-opus-4-7',
        tokens: [10, 400, 0, 9000],
      }),
    ].join('\n'),
  );
  // A subagent transcript logs its requests under the parent's session id.
  await writeFile(
    join(appDir, 'sess-main', 'subagents', 'agent-a1.jsonl'),
    [
      assistant({ timestamp: '2026-04-15T10:10:00Z', sessionId: 'sess-main', cwd: APP, tokens: [3, 50, 2000, 0], sidechain: 'a1' }),
      assistant({ timestamp: '2026-04-15T10:11:00Z', sessionId: 'sess-main', cwd: APP, tokens: [4, 60, 0, 2000], sidechain: 'a1' }),
    ].join('\n'),
  );
  await writeFile(
    join(libDir, 'sess-lib.jsonl'),
    [
      user('sess-lib', LIB, 'Add a parser'),
      assistant({ timestamp: '2026-04-16T08:00:00Z', sessionId: 'sess-lib', cwd: LIB, tokens: [7, 70, 700, 7000] }),
    ].join('\n'),
  );
});

afterAll(async () => {
  await flushCacheWrites();
  await rm(dir, { recursive: true, force: true });
});

const SESSION: ReportOptions = { groupBy: 'session', projects: [], providers: [] };

async function scanFixture(): Promise<{ entries: Entry[]; sessionMeta: Record<string, SessionMeta> }> {
  const result = await scanClaude({ dataDir: projects, useCache: false });
  return { entries: result.entries, sessionMeta: result.sessionMeta };
}

function expectRowsSumToTotals(report: ReturnType<typeof buildReport>): void {
  const sum = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  for (const row of report.rows) {
    sum.requests += row.requests;
    sum.input += row.tokens.input;
    sum.output += row.tokens.output;
    sum.cacheRead += row.tokens.cacheRead;
    sum.cacheWrite += row.tokens.cacheWrite;
    sum.total += row.tokens.total;
    sum.cost += row.costUsd.total;
  }
  const t = report.totals;
  expect(sum.requests).toBe(t.requests);
  expect(sum.input).toBe(t.tokens.input);
  expect(sum.output).toBe(t.tokens.output);
  expect(sum.cacheRead).toBe(t.tokens.cacheRead);
  expect(sum.cacheWrite).toBe(t.tokens.cacheWrite);
  expect(sum.total).toBe(t.tokens.total);
  // Each row is rounded to micro-dollars on its own.
  expect(Math.abs(sum.cost - t.costUsd.total)).toBeLessThanOrEqual(1e-6 * report.rows.length);
}

describe('report per session (Claude fixture logs)', () => {
  it('folds the subagent transcript into its parent and breaks it out', async () => {
    const { entries, sessionMeta } = await scanFixture();
    const report = buildReport(entries, sessionMeta, SESSION);
    expect(report.rows.length).toBe(2);

    const main = report.rows[0] as SessionRow;
    expect(main.sessionId).toBe('sess-main');
    expect(main.provider).toBe('cc');
    expect(main.project).toBe('app');
    expect(main.cwd).toBe(APP);
    expect(main.title).toBe('Fix the login bug');
    expect(main.requests).toBe(4);
    expect(main.models).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
    expect(main.firstAt).toBe('2026-04-15T10:00:00.000Z');
    expect(main.lastAt).toBe('2026-04-15T10:30:00.000Z');
    expect(main.tokens).toEqual({
      input: 100 + 10 + 3 + 4,
      output: 200 + 400 + 50 + 60,
      cacheWrite: 1000 + 2000,
      cacheRead: 5000 + 9000 + 2000,
      total: 117 + 710 + 3000 + 16000,
    });

    expect(main.subagents.length).toBe(1);
    const sub = main.subagents[0]!;
    expect(sub.id).toBe('a1');
    expect(sub.requests).toBe(2);
    expect(sub.tokens).toEqual({ input: 7, output: 110, cacheWrite: 2000, cacheRead: 2000, total: 4117 });

    const sessionEntries = entries.filter((e) => e.s === 'sess-main');
    const expectedCost = sessionEntries.reduce((sum, e) => {
      const c = costBreakdownForEntry(e);
      return sum + c.input + c.output + c.cacheRead + c.cacheWrite;
    }, 0);
    expect(main.costUsd.total).toBeCloseTo(expectedCost, 6);
    expect(main.costUsd.total).toBeGreaterThan(0);

    const lib = report.rows[1] as SessionRow;
    expect(lib.sessionId).toBe('sess-lib');
    expect(lib.subagents).toEqual([]);
    expectRowsSumToTotals(report);
    expect(report.totals.sessions).toBe(2);
  });

  it('per-session totals sum to the same total as the dashboard rows', async () => {
    const { entries, sessionMeta } = await scanFixture();
    const report = buildReport(entries, sessionMeta, SESSION);
    expectRowsSumToTotals(report);

    const rows = rollupEntries(entries);
    const dashboardCost = rows.reduce((sum, r) => sum + r.ci + r.co + r.cwc + r.crc, 0);
    const dashboardRequests = rows.reduce((sum, r) => sum + r.n, 0);
    expect(report.totals.requests).toBe(dashboardRequests);
    expect(report.totals.costUsd.total).toBeCloseTo(dashboardCost, 6);
  });

  it('filters by time, cwd substring and provider', async () => {
    const { entries, sessionMeta } = await scanFixture();
    const since = Date.parse('2026-04-15T10:05:00Z');
    const until = Date.parse('2026-04-15T10:20:00Z');
    const windowed = buildReport(entries, sessionMeta, { ...SESSION, since, until });
    expect(windowed.rows.length).toBe(1);
    expect(windowed.totals.requests).toBe(2);
    expect((windowed.rows[0] as SessionRow).subagents[0]?.requests).toBe(2);

    const byCwd = buildReport(entries, sessionMeta, { ...SESSION, projects: ['WORK/'] });
    expect(byCwd.rows.map((r) => (r as SessionRow).sessionId)).toEqual(['sess-lib']);

    const codexOnly = buildReport(entries, sessionMeta, { ...SESSION, providers: ['codex'] });
    expect(codexOnly.rows).toEqual([]);
    expect(codexOnly.totals.requests).toBe(0);
    expect(codexOnly.totals.firstAt).toBeNull();
  });

  it('groups by project, model and day with rows that sum to the total', async () => {
    const { entries, sessionMeta } = await scanFixture();
    for (const groupBy of ['project', 'model', 'day'] as const) {
      const report = buildReport(entries, sessionMeta, { ...SESSION, groupBy });
      expectRowsSumToTotals(report);
    }
    const byProject = buildReport(entries, sessionMeta, { ...SESSION, groupBy: 'project' });
    expect(byProject.rows.map((r) => ('project' in r ? r.project : ''))).toEqual(['app', 'lib']);
  });
});

describe('report with subagents logged as their own sessions', () => {
  function entry(s: string, t: number, src: Entry['src']): Entry {
    return { t, p: 'proj', s, m: 'gpt-5', i: 100, o: 10, cc: 0, cr: 50, f: 0, src };
  }

  it('folds subagent sessions into the root, but not forks', () => {
    const entries = [
      entry('parent', 1_000, 'codex'),
      entry('child', 2_000, 'codex'),
      entry('grandchild', 3_000, 'codex'),
      entry('fork', 4_000, 'codex'),
    ];
    const meta: Record<string, SessionMeta> = {
      parent: { firstPrompt: 'Plan the release', cwd: '/srv/proj' },
      child: { parentSessionId: 'parent', threadSource: 'subagent', agentNickname: 'scout' },
      grandchild: { parentSessionId: 'child', threadSource: 'subagent', agentRole: 'worker' },
      fork: { parentSessionId: 'parent', threadSource: 'user' },
    };
    const report = buildReport(entries, meta, SESSION);
    const rows = report.rows as SessionRow[];
    expect(rows.map((r) => r.sessionId)).toEqual(['parent', 'fork']);
    expect(rows[0]!.requests).toBe(3);
    expect(rows[0]!.title).toBe('Plan the release');
    expect(rows[0]!.subagents.map((s) => [s.id, s.label, s.requests])).toEqual([
      ['child', 'scout', 1],
      ['grandchild', 'worker', 1],
    ]);
    expect(report.totals.sessions).toBe(2);
    expectRowsSumToTotals(report);
  });

  it('survives a parent cycle', () => {
    const entries = [entry('a', 1, 'opencode'), entry('b', 2, 'opencode')];
    const meta: Record<string, SessionMeta> = {
      a: { parentSessionId: 'b', threadSource: 'subagent' },
      b: { parentSessionId: 'a', threadSource: 'subagent' },
    };
    const report = buildReport(entries, meta, SESSION);
    expect(report.totals.requests).toBe(2);
    expectRowsSumToTotals(report);
  });
});
