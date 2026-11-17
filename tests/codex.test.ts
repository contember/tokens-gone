import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _scanCodex as scanCodex } from '../server/providers/codex';
import { flushCacheWrites } from '../server/providers/base';

let dir: string;
let dataDir: string;
let cache: string;

function sessionLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-04-29T09:45:45.778Z',
    type: 'session_meta',
    payload: {
      id: '019dd89f-c5c5-7a92-be2d-39ad099e042a',
      timestamp: '2026-04-29T09:44:02.869Z',
      cwd: '/home/user/projects/example',
      originator: 'codex-tui',
      cli_version: '0.125.0',
      source: 'cli',
      model_provider: 'openai',
      ...over,
    },
  });
}

function turnContextLine(model: string, ts = '2026-04-29T09:45:45.779Z'): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'turn_context',
    payload: { turn_id: 't1', cwd: '/home/user/projects/example', model, effort: 'medium' },
  });
}

function userMsgLine(message: string, ts = '2026-04-29T09:45:45.780Z'): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'user_message', message, images: [], local_images: [], text_elements: [] },
  });
}

function taskStartedLine(turnId: string, ts: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: turnId,
      started_at: Math.floor(Date.parse(ts) / 1000),
    },
  });
}

function tokenCountLine(
  last: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens?: number },
  total: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens?: number } = last,
  ts = '2026-04-29T09:59:32.494Z',
): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { ...total, total_tokens: total.input_tokens + total.output_tokens },
        last_token_usage: { ...last, total_tokens: last.input_tokens + last.output_tokens },
        model_context_window: 258400,
      },
    },
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccdash-codex-'));
  dataDir = join(dir, 'sessions');
  cache = join(dir, 'cache.json');
  const sub = join(dataDir, '2026', '04', '29');
  await mkdir(sub, { recursive: true });

  // A typical session with two token_count events (one initial + one growth).
  await writeFile(
    join(sub, 'rollout-1.jsonl'),
    [
      sessionLine({
        session_id: 'parent-session',
        parent_thread_id: 'parent-session',
        thread_source: 'subagent',
        agent_nickname: 'Ada',
        agent_role: 'worker',
      }),
      turnContextLine('gpt-5.5'),
      userMsgLine('first prompt of the session'),
      // First call: 13875 input / 6528 cached / 144 output
      tokenCountLine({ input_tokens: 13875, cached_input_tokens: 6528, output_tokens: 144 }),
      // Second call: delta is input 14032, cached 6528, output 88 — `total_token_usage`
      // would be 27907/13056/232 cumulative, which we MUST NOT count.
      tokenCountLine(
        { input_tokens: 14032, cached_input_tokens: 6528, output_tokens: 88 },
        { input_tokens: 27907, cached_input_tokens: 13056, output_tokens: 232 },
        '2026-04-29T09:59:36.624Z',
      ),
      // Empty-pulse event_msg — should be skipped.
      tokenCountLine({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }),
      // Noise lines the parser should ignore.
      JSON.stringify({ type: 'response_item', payload: {} }),
      'not-json',
    ].join('\n'),
  );

  // An old-style codex session: session_meta + user message but no
  // token_count events. Should parse cleanly with zero entries.
  await writeFile(
    join(sub, 'rollout-old.jsonl'),
    [
      sessionLine({ id: 'old-session', cwd: '/home/me/projects/oss/dotaz', cli_version: '0.58.0' }),
      JSON.stringify({
        timestamp: '2026-03-06T18:04:25.987Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }],
        },
      }),
    ].join('\n'),
  );
});

afterAll(async () => {
  // scanCodex fires its cache write in the background (`void saveCache`);
  // drain it before removing the temp dir or the write lands after the dir
  // is gone and surfaces as an unhandled ENOENT between tests.
  await flushCacheWrites();
  await rm(dir, { recursive: true, force: true });
});

describe('codex scanner', () => {
  it('parses token_count events using last_token_usage and maps cache correctly', async () => {
    const r = await scanCodex({ dataDir, cachePath: cache });
    // Two real token_count events (third is empty-pulse skip) + old session contributes 0.
    expect(r.entries.length).toBe(2);

    const e1 = r.entries[0]!;
    expect(e1.src).toBe('codex');
    expect(e1.m).toBe('gpt-5.5');
    expect(e1.p).toBe('example');
    expect(e1.s).toBe('019dd89f-c5c5-7a92-be2d-39ad099e042a');
    // i = input_tokens - cached_input_tokens (non-cached portion)
    expect(e1.i).toBe(13875 - 6528);
    expect(e1.cr).toBe(6528);
    expect(e1.cc).toBe(0);
    expect(e1.o).toBe(144);
    expect(e1.f).toBe(0);

    const e2 = r.entries[1]!;
    // Critical: must come from last_token_usage, NOT total_token_usage
    expect(e2.i).toBe(14032 - 6528);
    expect(e2.o).toBe(88);
  });

  it('extracts firstPrompt from user_message events', async () => {
    const r = await scanCodex({ dataDir, cachePath: cache });
    const meta = r.sessionMeta['019dd89f-c5c5-7a92-be2d-39ad099e042a'];
    expect(meta?.firstPrompt).toBe('first prompt of the session');
    expect(meta?.parentSessionId).toBe('parent-session');
    expect(meta?.threadSource).toBe('subagent');
    expect(meta?.agentNickname).toBe('Ada');
    expect(meta?.agentRole).toBe('worker');
  });

  it('returns empty result when sessions dir does not exist', async () => {
    const r = await scanCodex({ dataDir: join(dir, 'does-not-exist'), useCache: false });
    expect(r.entries.length).toBe(0);
    expect(r.stats.files).toBe(0);
  });

  it('reuses cache for unchanged files on second scan', async () => {
    await scanCodex({ dataDir, cachePath: cache });
    const second = await scanCodex({ dataDir, cachePath: cache });
    expect(second.stats.cachedFiles).toBe(second.stats.files);
    expect(second.stats.parsedLines).toBe(0);
  });

  it('incrementally parses appended token_count events', async () => {
    await scanCodex({ dataDir, cachePath: cache });
    const target = join(dataDir, '2026', '04', '29', 'rollout-1.jsonl');
    await appendFile(
      target,
      '\n' + tokenCountLine(
        { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 50 },
        { input_tokens: 99999, cached_input_tokens: 99999, output_tokens: 99999 },
        '2026-04-29T10:00:00.000Z',
      ),
    );
    const r = await scanCodex({ dataDir, cachePath: cache });
    // Now 3 real entries — the appended one should pick up the previously
    // seen currentModel (gpt-5.5) without re-parsing the prefix.
    expect(r.entries.length).toBe(3);
    expect(r.entries[2]!.m).toBe('gpt-5.5');
    expect(r.entries[2]!.i).toBe(500);
    expect(r.entries[2]!.cr).toBe(500);
    expect(r.entries[2]!.o).toBe(50);
    // Only the appended file should have parsed lines.
    expect(r.stats.cachedFiles).toBe(r.stats.files - 1);
  });

  it('skips inherited usage copied into a forked session', async () => {
    const forkDir = join(dataDir, '2026', '07', '18', 'fork-cold');
    await mkdir(forkDir, { recursive: true });
    const childId = '019f76ec-4fab-7010-9762-aba3c8859556';
    const parentId = '019f5b60-d986-7e62-8e3f-7ddff31b77a3';

    await writeFile(
      join(forkDir, 'rollout-fork.jsonl'),
      [
        sessionLine({
          id: childId,
          session_id: parentId,
          parent_thread_id: parentId,
          forked_from_id: parentId,
          timestamp: '2026-07-18T20:30:26.254Z',
          thread_source: 'subagent',
          agent_nickname: 'Lorentz',
        }),
        sessionLine({
          id: parentId,
          session_id: parentId,
          timestamp: '2026-07-13T12:08:21.679Z',
          thread_source: 'user',
        }),
        turnContextLine('gpt-5.6-sol', '2026-07-18T20:30:26.971Z'),
        userMsgLine('inherited parent prompt', '2026-07-18T20:30:26.971Z'),
        tokenCountLine(
          { input_tokens: 1_800_000_000, cached_input_tokens: 1_750_000_000, output_tokens: 2_000_000 },
          undefined,
          '2026-07-18T20:30:27.457Z',
        ),
        taskStartedLine('019f76ec-54de-74a1-89c5-1a788201d0f3', '2026-07-18T20:30:27.563Z'),
        turnContextLine('gpt-5.6-sol', '2026-07-18T20:30:29.040Z'),
        userMsgLine('child task', '2026-07-18T20:30:29.051Z'),
        tokenCountLine(
          { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 50 },
          undefined,
          '2026-07-18T20:30:36.210Z',
        ),
      ].join('\n'),
    );

    const r = await scanCodex({ dataDir, cachePath: cache });
    const entries = r.entries.filter((e) => e.s === childId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.i).toBe(600);
    expect(entries[0]!.cr).toBe(400);
    expect(entries[0]!.o).toBe(50);
    expect(entries[0]!.m).toBe('gpt-5.6-sol');
    expect(r.sessionMeta[childId]).toEqual({
      firstPrompt: 'child task',
      parentSessionId: parentId,
      threadSource: 'subagent',
      agentNickname: 'Lorentz',
      cwd: '/home/user/projects/example',
    });
  });

  it('keeps fork history pending across incremental scans', async () => {
    const forkDir = join(dataDir, '2026', '07', '18', 'fork-incremental');
    await mkdir(forkDir, { recursive: true });
    const path = join(forkDir, 'rollout-fork.jsonl');
    const childId = '019f76ec-cb8d-7620-a734-52704fafcd1d';
    const parentId = '019f5b60-d986-7e62-8e3f-7ddff31b77a3';

    await writeFile(
      path,
      [
        sessionLine({
          id: childId,
          session_id: parentId,
          parent_thread_id: parentId,
          forked_from_id: parentId,
          timestamp: '2026-07-18T20:30:58.012Z',
          thread_source: 'subagent',
        }),
        sessionLine({ id: parentId, session_id: parentId, thread_source: 'user' }),
        turnContextLine('gpt-5.6-sol', '2026-07-18T20:30:58.100Z'),
        tokenCountLine(
          { input_tokens: 1_800_000_000, cached_input_tokens: 1_750_000_000, output_tokens: 2_000_000 },
          undefined,
          '2026-07-18T20:30:58.200Z',
        ),
      ].join('\n'),
    );

    const beforeStart = await scanCodex({ dataDir, cachePath: cache });
    expect(beforeStart.entries.some((e) => e.s === childId)).toBe(false);

    await appendFile(
      path,
      '\n' + [
        taskStartedLine('019f76ec-d500-7000-8000-000000000001', '2026-07-18T20:30:59.282Z'),
        turnContextLine('gpt-5.6-sol', '2026-07-18T20:31:00.000Z'),
        tokenCountLine(
          { input_tokens: 2_000, cached_input_tokens: 1_000, output_tokens: 100 },
          undefined,
          '2026-07-18T20:31:05.000Z',
        ),
      ].join('\n'),
    );

    const afterStart = await scanCodex({ dataDir, cachePath: cache });
    const entries = afterStart.entries.filter((e) => e.s === childId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.i).toBe(1_000);
    expect(entries[0]!.cr).toBe(1_000);
    expect(entries[0]!.o).toBe(100);
  });
});

describe('codex incremental scan', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ccdash-codex-inc-'));
  });

  afterAll(async () => {
    await flushCacheWrites();
    await rm(root, { recursive: true, force: true });
  });

  it('gives the same entries and session meta as a cold parse after appended lines', async () => {
    const sessions = join(root, 'sessions');
    const day = join(sessions, '2026', '05', '02');
    await mkdir(day, { recursive: true });
    const cachePath = join(root, 'cache.json');
    const metaFirst = join(day, 'rollout-meta-first.jsonl');
    const partialMeta = join(day, 'rollout-partial-meta.jsonl');

    const metaLine = sessionLine({ id: '019de4a1-0000-7000-8000-000000000001', cwd: '/home/user/projects/alpha' });
    // Session metadata and the model arrive before the first scan, usage only after it.
    await writeFile(metaFirst, [metaLine, turnContextLine('gpt-5.5'), userMsgLine('hello')].join('\n') + '\n');
    // The first scan sees half of the session_meta line.
    const partialLine = sessionLine({ id: '019de4a1-0000-7000-8000-000000000002', cwd: '/home/user/projects/beta' });
    await writeFile(partialMeta, partialLine.slice(0, 40));

    const first = await scanCodex({ dataDir: sessions, cachePath });
    expect(first.entries.length).toBe(0);

    const subdirTurn = JSON.stringify({
      timestamp: '2026-05-02T10:00:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 't2', cwd: '/home/user/projects/alpha/packages/web', model: 'gpt-5.6-sol' },
    });
    await appendFile(
      metaFirst,
      [
        tokenCountLine({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, undefined, '2026-05-02T10:00:00.000Z'),
        subdirTurn,
        tokenCountLine({ input_tokens: 200, cached_input_tokens: 80, output_tokens: 20 }, undefined, '2026-05-02T10:00:02.000Z'),
      ].join('\n') + '\n',
    );
    await appendFile(
      partialMeta,
      partialLine.slice(40) + '\n' + [
        turnContextLine('gpt-5.5', '2026-05-02T11:00:00.000Z'),
        userMsgLine('second session', '2026-05-02T11:00:00.100Z'),
        tokenCountLine({ input_tokens: 300, cached_input_tokens: 0, output_tokens: 30 }, undefined, '2026-05-02T11:00:01.000Z'),
      ].join('\n') + '\n',
    );

    const incremental = await scanCodex({ dataDir: sessions, cachePath });
    // Only the appended lines of each file were read.
    expect(incremental.stats.parsedLines).toBe(3 + 4);
    const cold = await scanCodex({ dataDir: sessions, useCache: false });

    expect(incremental.entries).toEqual(cold.entries);
    expect(incremental.sessionMeta).toEqual(cold.sessionMeta);
    expect(cold.entries.map((e) => [e.p, e.m])).toEqual([
      ['alpha', 'gpt-5.5'],
      ['alpha', 'gpt-5.6-sol'],
      ['beta', 'gpt-5.5'],
    ]);
  });
});
