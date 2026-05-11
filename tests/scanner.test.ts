import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _scanClaude as scan } from '../server/providers/claude';

let dir: string;
let projects: string;
let cache: string;

let idCounter = 0;
function makeLine(over: Record<string, unknown> = {}): string {
  // Each call gets unique msg/req IDs by default, so callers can opt into
  // duplicates only by passing the same id explicitly.
  const n = ++idCounter;
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-04-15T10:00:00Z',
    sessionId: 'sess-A',
    requestId: `req-${n}`,
    cwd: '/x',
    message: {
      id: `msg-${n}`,
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
        speed: 'standard',
      },
    },
    ...over,
  });
}

function makeLineFixed(msgId: string, reqId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-04-15T10:00:00Z',
    sessionId: 'sess-A',
    requestId: reqId,
    cwd: '/x',
    message: {
      id: msgId,
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
    },
    ...over,
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccdash-'));
  projects = join(dir, 'projects');
  cache = join(dir, 'cache.json');
  await mkdir(join(projects, '-home-user-projects-foo'), { recursive: true });
  await mkdir(join(projects, '-home-user-projects-bar'), { recursive: true });

  await writeFile(
    join(projects, '-home-user-projects-foo', 'sess1.jsonl'),
    [
      JSON.stringify({ type: 'user', text: 'noise' }),
      makeLine(),
      makeLine({ message: { id: 'msg-2', model: 'claude-opus-4-7', usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      '',
      'not-json-at-all',
    ].join('\n'),
  );

  await writeFile(
    join(projects, '-home-user-projects-bar', 'sess2.jsonl'),
    [
      makeLine({ timestamp: '2026-04-16T10:00:00Z', sessionId: 'sess-B' }),
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('scanner', () => {
  it('parses usage entries and ignores noise/invalid lines', async () => {
    const r = await scan({ dataDir: projects, cachePath: cache });
    expect(r.entries.length).toBe(3);
    expect(r.stats.files).toBe(2);
    const projects_ = new Set(r.entries.map((e) => e.p));
    expect(projects_.has('foo')).toBe(true);
    expect(projects_.has('bar')).toBe(true);
  });

  it('deduplicates entries with the same msgId:reqId across files', async () => {
    // Same msg/req IDs as the first line of sess1.jsonl → must be deduped.
    const dupDir = join(projects, '-home-user-projects-dup');
    await mkdir(dupDir, { recursive: true });
    await writeFile(join(dupDir, 'dup.jsonl'), makeLineFixed('msg-1', 'req-1'));

    const r = await scan({ dataDir: projects, cachePath: cache });
    // sess1.jsonl line 1 (which beforeAll wrote with makeLine() → assigns
    // msg-1:req-1 as the first call) and dup.jsonl both carry msg-1:req-1.
    // Dedup must collapse them so we get exactly one entry with those tokens.
    const dupSignature = r.entries.filter(
      (e) => e.i === 10 && e.o === 20 && e.cc === 30 && e.cr === 40 && e.s === 'sess-A',
    );
    expect(dupSignature.length).toBe(1);

    await rm(dupDir, { recursive: true });
  });

  it('uses cache for unchanged files (second scan parses nothing)', async () => {
    await scan({ dataDir: projects, cachePath: cache });
    const second = await scan({ dataDir: projects, cachePath: cache });
    expect(second.stats.cachedFiles).toBe(second.stats.files);
    expect(second.stats.parsedLines).toBe(0);
  });

  it('incrementally parses appended content', async () => {
    await scan({ dataDir: projects, cachePath: cache });
    const target = join(projects, '-home-user-projects-foo', 'sess1.jsonl');
    await appendFile(
      target,
      '\n' +
        makeLine({
          timestamp: '2026-04-15T11:00:00Z',
          message: {
            id: 'msg-99',
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 1,
              cache_read_input_tokens: 1,
            },
          },
        }),
    );

    const r = await scan({ dataDir: projects, cachePath: cache });
    expect(r.entries.length).toBe(4);
    // Only the appended file should have parsed lines; the other is still cached.
    expect(r.stats.cachedFiles).toBe(r.stats.files - 1);
    expect(r.stats.parsedLines).toBeGreaterThan(0);
    expect(r.stats.parsedLines).toBeLessThan(10);
  });

  it('dedupes streaming chunks by msgId:reqId, keeping max output_tokens', async () => {
    // Simulates Claude Code's behavior of logging multiple chunks per request
    // during streaming, each with the same msgId+reqId but growing output_tokens.
    const streamDir = join(projects, '-home-user-projects-stream');
    await mkdir(streamDir, { recursive: true });
    const lines = [
      // 3 chunks of the same request — output_tokens grows from 1 → 50 → 200.
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-15T12:00:01Z',
        sessionId: 'sess-S',
        requestId: 'req-X',
        message: {
          id: 'msg-X',
          model: 'claude-opus-4-7',
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-15T12:00:02Z',
        sessionId: 'sess-S',
        requestId: 'req-X',
        message: {
          id: 'msg-X',
          model: 'claude-opus-4-7',
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-15T12:00:03Z',
        sessionId: 'sess-S',
        requestId: 'req-X',
        message: {
          id: 'msg-X',
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000 },
        },
      }),
    ];
    await writeFile(join(streamDir, 's.jsonl'), lines.join('\n'));

    const r = await scan({ dataDir: projects, cachePath: cache });
    const streamed = r.entries.filter((e) => e.s === 'sess-S');
    expect(streamed.length).toBe(1);
    expect(streamed[0]!.o).toBe(200);
    expect(streamed[0]!.i).toBe(100);

    await rm(streamDir, { recursive: true });
  });

  it('dedupes across files when subagent JSONL replicates parent session calls', async () => {
    // Parent session and subagent both log the same msgId:reqId.
    const subDir = join(projects, '-home-user-projects-multifile');
    await mkdir(join(subDir, 'subagents'), { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-04-15T13:00:00Z',
      sessionId: 'sess-M',
      requestId: 'req-MM',
      message: {
        id: 'msg-MM',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 5, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
      },
    });
    await writeFile(join(subDir, 'parent.jsonl'), line);
    await writeFile(join(subDir, 'subagents', 'agent.jsonl'), line);

    const r = await scan({ dataDir: projects, cachePath: cache });
    const hits = r.entries.filter((e) => e.s === 'sess-M');
    expect(hits.length).toBe(1);

    await rm(subDir, { recursive: true });
  });

  it('skips entries with synthetic model', async () => {
    const synthDir = join(projects, '-home-user-projects-synth');
    await mkdir(synthDir, { recursive: true });
    await writeFile(
      join(synthDir, 's.jsonl'),
      makeLine({ message: { id: 'mx', model: '<synthetic>', usage: { input_tokens: 1, output_tokens: 1 } } }),
    );

    const r = await scan({ dataDir: projects, cachePath: cache });
    expect(r.entries.find((e) => e.m === '<synthetic>')).toBeUndefined();

    await rm(synthDir, { recursive: true });
  });
});
