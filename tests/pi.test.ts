import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _scanPi as scanPi } from '../server/providers/pi';
import { flushCacheWrites } from '../server/providers/base';

let dir: string;
let dataDir: string;
let cache: string;

const sessionId = '01jz7am66t3v0k6q9jkejqv7bk';

function sessionLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session',
    timestamp: '2026-06-01T09:00:00.000Z',
    session: {
      id: sessionId,
      cwd: '/home/me/projects/tokens-gone',
      ...over,
    },
  });
}

function userLine(content = 'first Pi prompt'): string {
  return JSON.stringify({
    type: 'message',
    timestamp: '2026-06-01T09:01:00.000Z',
    message: {
      role: 'user',
      content,
      timestamp: Date.parse('2026-06-01T09:01:00.000Z'),
    },
  });
}

function infoLine(name = 'Build Pi support'): string {
  return JSON.stringify({
    type: 'session_info',
    timestamp: '2026-06-01T09:01:30.000Z',
    name,
  });
}

function assistantLine(
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cacheWrite1h?: number;
    };
  },
  ts = '2026-06-01T09:02:00.000Z',
): string {
  return JSON.stringify({
    type: 'message',
    timestamp: ts,
    message: {
      role: 'assistant',
      content: 'ok',
      model: 'openrouter/auto',
      responseModel: 'anthropic/claude-sonnet-4-6',
      timestamp: Date.parse(ts) + 123,
      usage,
    },
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tokens-gone-pi-'));
  dataDir = join(dir, 'sessions');
  cache = join(dir, 'pi-cache.json');
  const sessionDir = join(dataDir, '--home-me-projects-tokens-gone--');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, '2026-06-01T09-00-00.000Z_01jz7am66t3v0k6q9jkejqv7bk.jsonl'),
    [
      sessionLine(),
      userLine(),
      infoLine(),
      assistantLine({
        input: 100,
        output: 25,
        cacheRead: 40,
        cacheWrite: 5,
        cacheWrite1h: 7,
        cost: {
          input: 0.0003,
          output: 0.0004,
          cacheRead: 0.00001,
          cacheWrite: 0.00002,
          cacheWrite1h: 0.00003,
        },
      }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 0, output: 0 } } }),
      'not-json',
    ].join('\n'),
  );
});

afterAll(async () => {
  await flushCacheWrites();
  await rm(dir, { recursive: true, force: true });
});

describe('pi scanner', () => {
  it('parses assistant message usage, metadata, and Pi cost components', async () => {
    const r = await scanPi({ dataDir, cachePath: cache });
    expect(r.entries.length).toBe(1);
    expect(r.stats.files).toBe(1);

    const e = r.entries[0]!;
    expect(e.src).toBe('pi');
    expect(e.p).toBe('tokens-gone');
    expect(e.s).toBe(sessionId);
    expect(e.m).toBe('anthropic/claude-sonnet-4-6');
    expect(e.i).toBe(100);
    expect(e.o).toBe(25);
    expect(e.cr).toBe(40);
    expect(e.cc).toBe(12);
    expect(e.ci).toBe(0.0003);
    expect(e.co).toBe(0.0004);
    expect(e.crc).toBe(0.00001);
    expect(e.cwc).toBe(0.00005);
    expect(e.t).toBe(Date.parse('2026-06-01T09:02:00.000Z') + 123);

    expect(r.sessionMeta[sessionId]).toEqual({
      summary: 'Build Pi support',
      firstPrompt: 'first Pi prompt',
    });
  });

  it('returns empty result when sessions dir does not exist', async () => {
    const r = await scanPi({ dataDir: join(dir, 'does-not-exist'), useCache: false });
    expect(r.entries.length).toBe(0);
    expect(r.stats.files).toBe(0);
  });

  it('reuses cache for unchanged files on second scan', async () => {
    await scanPi({ dataDir, cachePath: cache });
    const second = await scanPi({ dataDir, cachePath: cache });
    expect(second.stats.cachedFiles).toBe(second.stats.files);
    expect(second.stats.parsedLines).toBe(0);
  });

  it('incrementally parses appended assistant messages', async () => {
    await scanPi({ dataDir, cachePath: cache });
    const target = join(
      dataDir,
      '--home-me-projects-tokens-gone--',
      '2026-06-01T09-00-00.000Z_01jz7am66t3v0k6q9jkejqv7bk.jsonl',
    );
    await appendFile(
      target,
      '\n' + assistantLine(
        { input: 20, output: 3, cacheRead: 4, cacheWrite: 1 },
        '2026-06-01T09:03:00.000Z',
      ),
    );

    const r = await scanPi({ dataDir, cachePath: cache });
    expect(r.entries.length).toBe(2);
    expect(r.entries[1]!.i).toBe(20);
    expect(r.entries[1]!.o).toBe(3);
    expect(r.entries[1]!.cr).toBe(4);
    expect(r.entries[1]!.cc).toBe(1);
    expect(r.stats.cachedFiles).toBe(r.stats.files - 1);
  });
});
