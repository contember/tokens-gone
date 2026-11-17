import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReportArgs } from '../server/reportCli';

let dir: string;

const CLI = join(import.meta.dir, '..', 'server', 'cli.ts');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tokens-gone-report-cli-'));
  const project = join(dir, 'claude', 'projects', '-home-user-app');
  await mkdir(join(project, 's1', 'subagents'), { recursive: true });
  const line = (n: number, timestamp: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp,
      sessionId: 's1',
      cwd: '/home/user/app',
      requestId: `req-${n}`,
      ...extra,
      message: {
        id: `msg-${n}`,
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
      },
    });
  await writeFile(join(project, 's1.jsonl'), line(1, '2026-04-15T10:00:00Z'));
  await writeFile(
    join(project, 's1', 'subagents', 'agent-x.jsonl'),
    line(2, '2026-04-15T10:01:00Z', { isSidechain: true, agentId: 'x' }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = join(dir, 'home');
  const proc = Bun.spawn([process.execPath, CLI, 'report', ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      CODEX_HOME: join(home, 'none'),
      XDG_DATA_HOME: join(home, 'none'),
      PI_CODING_AGENT_DIR: join(home, 'none'),
      OMP_CODING_AGENT_DIR: join(home, 'none'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('tokens-gone report CLI', () => {
  it('prints the JSON report with rows and totals', async () => {
    const { code, stdout, stderr } = await run(['--since', '2026-04-01', '--group-by', 'session', '--json']);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(Object.keys(report)).toEqual(['groupBy', 'since', 'until', 'rows', 'totals']);
    expect(report.groupBy).toBe('session');
    expect(report.until).toBeNull();
    expect(report.rows.length).toBe(1);
    const row = report.rows[0];
    expect(Object.keys(row)).toEqual([
      'provider', 'sessionId', 'project', 'cwd', 'title',
      'firstAt', 'lastAt', 'requests', 'models', 'tokens', 'costUsd', 'subagents',
    ]);
    expect(row).toMatchObject({
      provider: 'cc',
      sessionId: 's1',
      project: 'app',
      cwd: '/home/user/app',
      requests: 2,
      models: ['claude-sonnet-4-6'],
      tokens: { input: 20, output: 40, cacheWrite: 60, cacheRead: 80, total: 200 },
    });
    expect(Object.keys(row.costUsd)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite', 'total']);
    expect(row.subagents).toMatchObject([{ id: 'x', label: null, requests: 1 }]);
    expect(report.totals).toMatchObject({ sessions: 1, requests: 2, tokens: row.tokens, costUsd: row.costUsd });
  });

  it('prints one row per line with --jsonl', async () => {
    const { code, stdout } = await run(['--jsonl', '--group-by', 'day']);
    expect(code).toBe(0);
    const lines = stdout.trimEnd().split('\n');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ requests: 2, sessions: 1 });
  });

  it('prints a table with a total line when asked', async () => {
    const { code, stdout } = await run(['--format', 'table']);
    expect(code).toBe(0);
    expect(stdout).toContain('TOTAL');
    expect(stdout).toContain('(+1 subagents)');
  });

  it('exits 2 with a JSON error on stderr for bad input', async () => {
    const { code, stdout, stderr } = await run(['--since', 'yesterday', '--json']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr)).toEqual({
      error: { code: 'usage', message: '--since: expected a date (YYYY-MM-DD) or an ISO time, got "yesterday"' },
    });
  });

  it('exits 2 with a plain error for an unknown option', async () => {
    const { code, stderr } = await run(['--bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown option --bogus');
  });
});

describe('parseReportArgs', () => {
  it('reads dates as local days, with --until covering the whole day', () => {
    const args = parseReportArgs(['--since', '2026-11-16', '--until', '2026-11-16'], false)!;
    expect(args.since).toBe(new Date(2026, 10, 16).getTime());
    expect(args.until).toBe(new Date(2026, 10, 17).getTime());
  });

  it('reads ISO times as given', () => {
    const args = parseReportArgs(['--since=2026-11-16T08:30:00Z'], false)!;
    expect(args.since).toBe(Date.parse('2026-11-16T08:30:00Z'));
  });

  it('defaults to json off a terminal and table on one', () => {
    expect(parseReportArgs([], false)!.format).toBe('json');
    expect(parseReportArgs([], true)!.format).toBe('table');
  });

  it('accepts comma-separated providers', () => {
    expect(parseReportArgs(['--provider', 'cc,codex', '--provider', 'cc'], false)!.providers).toEqual(['cc', 'codex']);
  });

  it('rejects bad input', () => {
    expect(() => parseReportArgs(['--since', '2026-02-30'], false)).toThrow('--since');
    expect(() => parseReportArgs(['--group-by', 'week'], false)).toThrow('--group-by');
    expect(() => parseReportArgs(['--provider', 'claude'], false)).toThrow('unknown provider');
    expect(() => parseReportArgs(['--since', '2026-11-17', '--until', '2026-11-16'], false)).toThrow('before');
    expect(() => parseReportArgs(['--json', '--format', 'table'], false)).toThrow('conflicting');
    expect(() => parseReportArgs(['--since'], false)).toThrow('needs a value');
    expect(() => parseReportArgs(['extra'], false)).toThrow('unexpected argument');
  });

  it('returns undefined for --help', () => {
    expect(parseReportArgs(['--help'], false)).toBeUndefined();
  });
});
