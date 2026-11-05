import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _readClaudeTranscript as readTranscript, _scanClaude as scan } from '../server/providers/claude';
import type { Entry } from '../server/types';
import { flushCacheWrites } from '../server/providers/base';

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
    cwd: '/home/user/projects/foo',
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
    cwd: '/home/user/projects/foo',
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
  cache = join(dir, 'claude-cache');
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
      makeLine({
        timestamp: '2026-04-16T10:00:00Z',
        sessionId: 'sess-B',
        cwd: '/home/user/projects/bar',
      }),
    ].join('\n'),
  );
});

afterAll(async () => {
  // scan fires its cache write in the background (`void saveCache`); drain
  // it before removing the temp dir or the write lands after the dir is
  // gone and surfaces as an unhandled ENOENT between tests.
  await flushCacheWrites();
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

  it('attributes mirrored calls to the foreground session', async () => {
    const mirrorDir = join(projects, '-home-user-projects-mirror');
    await mkdir(mirrorDir, { recursive: true });
    const background = makeLineFixed('msg-mirror', 'req-mirror', {
      sessionId: 'sess-background',
      sessionKind: 'bg',
    });
    const foreground = makeLineFixed('msg-mirror', 'req-mirror', {
      sessionId: 'sess-foreground',
    });
    await writeFile(join(mirrorDir, 'a-background.jsonl'), background);
    await writeFile(join(mirrorDir, 'z-foreground.jsonl'), foreground);

    const r = await scan({ dataDir: projects, cachePath: cache });
    const mirrored = r.entries.filter((e) => e.h === 'msg-mirror:req-mirror');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]!.s).toBe('sess-foreground');

    await rm(mirrorDir, { recursive: true });
  });

  it('preserves cached entries when source jsonl is deleted from disk', async () => {
    // Simulates Claude Code's cleanupPeriodDays sweep wiping a session file
    // that we already have in cache. The entries must survive the next scan.
    const ephDir = join(projects, '-home-user-projects-ephemeral');
    await mkdir(ephDir, { recursive: true });
    const ephFile = join(ephDir, 'will-be-deleted.jsonl');
    await writeFile(
      ephFile,
      makeLine({
        timestamp: '2026-03-20T10:00:00Z',
        sessionId: 'sess-DELETED',
        message: {
          id: 'msg-D',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 111,
            output_tokens: 222,
            cache_creation_input_tokens: 333,
            cache_read_input_tokens: 444,
          },
        },
      }),
    );

    const first = await scan({ dataDir: projects, cachePath: cache });
    const beforeDelete = first.entries.filter((e) => e.s === 'sess-DELETED');
    expect(beforeDelete.length).toBe(1);

    await rm(ephDir, { recursive: true });

    const second = await scan({ dataDir: projects, cachePath: cache });
    const afterDelete = second.entries.filter((e) => e.s === 'sess-DELETED');
    expect(afterDelete.length).toBe(1);
    expect(afterDelete[0]!.i).toBe(111);
    expect(afterDelete[0]!.o).toBe(222);
    expect(afterDelete[0]!.cc).toBe(333);
    expect(afterDelete[0]!.cr).toBe(444);

    // And the survival must be persistent across cache reload — a third scan
    // (cold-loading cache from disk again) should still have it.
    const third = await scan({ dataDir: projects, cachePath: cache });
    expect(third.entries.filter((e) => e.s === 'sess-DELETED').length).toBe(1);
  });

  it('names projects from cwd, not the lossy encoded dir', async () => {
    // Claude Code encodes the cwd by replacing both `/` and `-` with `-`,
    // so the encoded dir `-home-user-projects-tokens-gone` can't be split
    // back into "tokens-gone" from the dir alone. The cwd recorded in the
    // JSONL itself is the source of truth.
    const hyphenDir = join(projects, '-home-user-projects-tokens-gone');
    await mkdir(hyphenDir, { recursive: true });
    await writeFile(
      join(hyphenDir, 'sess.jsonl'),
      makeLine({
        sessionId: 'sess-HYPHEN',
        cwd: '/home/user/projects/tokens-gone',
      }),
    );

    const r = await scan({ dataDir: projects, cachePath: cache });
    const hit = r.entries.find((e) => e.s === 'sess-HYPHEN');
    expect(hit?.p).toBe('tokens-gone');

    await rm(hyphenDir, { recursive: true });
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

describe('claude cache', () => {
  let root: string;
  let dataDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ccdash-cache-'));
    dataDir = join(root, 'projects');
    cacheDir = join(root, 'claude-cache');
    await mkdir(join(dataDir, '-p-alpha'), { recursive: true });
    await mkdir(join(dataDir, '-p-beta'), { recursive: true });
  });

  afterEach(async () => {
    await flushCacheWrites();
    await rm(root, { recursive: true, force: true });
  });

  function usageLine(msgId: string, output: number, over: Record<string, unknown> = {}): string {
    return makeLineFixed(msgId, `req-${msgId}`, {
      message: {
        id: msgId,
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1,
          output_tokens: output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      ...over,
    });
  }

  /** Shard files by the project dir they hold. */
  async function shardsByKey(): Promise<Map<string, { file: string; mtimeMs: number }>> {
    const out = new Map<string, { file: string; mtimeMs: number }>();
    for (const name of await readdir(cacheDir)) {
      const file = join(cacheDir, name);
      const shard = JSON.parse(await readFile(file, 'utf-8')) as { key: string };
      out.set(shard.key, { file, mtimeMs: (await stat(file)).mtimeMs });
    }
    return out;
  }

  function canonical(entries: Entry[]): string[] {
    return entries.map((e) => `${e.h ?? '-'}|${e.t}|${e.s}|${e.p}|${e.o}`).sort();
  }

  it('reads a half-written last line once it is complete', async () => {
    const path = join(dataDir, '-p-alpha', 's.jsonl');
    const second = usageLine('m-2', 9);
    await writeFile(path, `${usageLine('m-1', 5)}\n${second.slice(0, 60)}`);

    const first = await scan({ dataDir, cachePath: cacheDir });
    expect(first.entries.map((e) => e.h)).toEqual(['m-1:req-m-1']);

    await appendFile(path, `${second.slice(60)}\n`);
    const r = await scan({ dataDir, cachePath: cacheDir });
    expect(r.entries.map((e) => e.h).sort()).toEqual(['m-1:req-m-1', 'm-2:req-m-2']);
    expect(r.entries.find((e) => e.h === 'm-2:req-m-2')?.o).toBe(9);
  });

  it('rewrites only the shard of the project that changed', async () => {
    const alpha = join(dataDir, '-p-alpha', 'a.jsonl');
    await writeFile(alpha, `${usageLine('a-1', 1)}\n`);
    await writeFile(join(dataDir, '-p-beta', 'b.jsonl'), `${usageLine('b-1', 1)}\n`);
    await scan({ dataDir, cachePath: cacheDir });
    await flushCacheWrites();
    const before = await shardsByKey();
    expect([...before.keys()].sort()).toEqual(['-p-alpha', '-p-beta']);

    await appendFile(alpha, `${usageLine('a-2', 1)}\n`);
    await scan({ dataDir, cachePath: cacheDir });
    await flushCacheWrites();
    const after = await shardsByKey();
    expect(after.get('-p-alpha')!.mtimeMs).not.toBe(before.get('-p-alpha')!.mtimeMs);
    expect(after.get('-p-beta')!.mtimeMs).toBe(before.get('-p-beta')!.mtimeMs);
  });

  it('migrates the single-file cache, keeping records of deleted logs', async () => {
    const deletedPath = join(dataDir, '-p-alpha', 'deleted.jsonl');
    const legacy = join(root, 'cache.json');
    await writeFile(legacy, JSON.stringify({
      version: 4,
      files: {
        [deletedPath]: {
          path: deletedPath,
          size: 100,
          mtimeMs: 1,
          entries: [{ t: 1, p: '', s: 'sess-gone', m: 'claude-sonnet-4-6', i: 1, o: 2, cc: 0, cr: 0, f: 0, h: 'gone:1' }],
          sessionId: 'sess-gone',
          cwd: '/home/user/alpha',
        },
      },
    }));
    await writeFile(join(dataDir, '-p-beta', 'b.jsonl'), `${usageLine('b-1', 1)}\n`);

    const r = await scan({ dataDir, cachePath: cacheDir });
    expect(r.entries.find((e) => e.s === 'sess-gone')?.p).toBe('alpha');
    await flushCacheWrites();
    expect(await stat(legacy).catch(() => null)).toBeNull();

    // A path the process hasn't loaded yet: the shards are read from disk.
    const link = join(root, 'claude-cache-link');
    await symlink(cacheDir, link);
    const reloaded = await scan({ dataDir, cachePath: link });
    expect(reloaded.entries.find((e) => e.s === 'sess-gone')?.o).toBe(2);
    expect(reloaded.stats.parsedLines).toBe(0);
  });

  it('merges changed files incrementally with the same result as a full scan', async () => {
    const parent = join(dataDir, '-p-alpha', 'parent.jsonl');
    await writeFile(parent, [usageLine('m-1', 5), usageLine('m-2', 3)].join('\n') + '\n');
    await mkdir(join(dataDir, '-p-alpha', 'subagents'), { recursive: true });
    await writeFile(join(dataDir, '-p-alpha', 'subagents', 'agent.jsonl'), `${usageLine('m-1', 5)}\n`);
    await writeFile(
      join(dataDir, '-p-beta', 'bg.jsonl'),
      `${usageLine('m-3', 4, { sessionId: 'sess-bg', sessionKind: 'bg', cwd: '/home/user/beta' })}\n`,
    );
    await scan({ dataDir, cachePath: cacheDir });

    // A larger chunk of m-1, a new call, a foreground copy of the mirrored
    // m-3 and a hashless call duplicated by the subagent log.
    const hashless = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-04-15T10:05:00Z',
      sessionId: 'sess-A',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 2, output_tokens: 2 } },
    });
    await appendFile(parent, [usageLine('m-1', 50), usageLine('m-4', 1), hashless].join('\n') + '\n');
    await appendFile(join(dataDir, '-p-alpha', 'subagents', 'agent.jsonl'), `${hashless}\n`);
    await writeFile(
      join(dataDir, '-p-beta', 'fg.jsonl'),
      `${usageLine('m-3', 4, { sessionId: 'sess-fg', cwd: '/home/user/beta' })}\n`,
    );

    const incremental = await scan({ dataDir, cachePath: cacheDir });
    const full = await scan({ dataDir, useCache: false });
    expect(canonical(incremental.entries)).toEqual(canonical(full.entries));
    expect(incremental.entries.filter((e) => e.h === 'm-1:req-m-1').map((e) => e.o)).toEqual([50]);
    expect(incremental.entries.find((e) => e.h === 'm-3:req-m-3')?.s).toBe('sess-fg');
    expect(incremental.entries.filter((e) => !e.h).length).toBe(1);
    expect(new Set(incremental.entries.filter((e) => e.s === 'sess-bg' || e.s === 'sess-fg').map((e) => e.p)))
      .toEqual(new Set(['beta']));
  });

  it('rebuilds the merge when a known file is rewritten', async () => {
    const path = join(dataDir, '-p-alpha', 's.jsonl');
    await writeFile(path, [usageLine('r-1', 5), usageLine('r-2', 5), usageLine('r-3', 5)].join('\n') + '\n');
    await writeFile(join(dataDir, '-p-alpha', 'copy.jsonl'), `${usageLine('r-1', 2)}\n`);
    await scan({ dataDir, cachePath: cacheDir });

    // Shorter than before: the file was replaced, not appended to.
    await writeFile(path, `${usageLine('r-3', 1, { sessionKind: 'bg' })}\n`);
    const r = await scan({ dataDir, cachePath: cacheDir });
    expect(canonical(r.entries)).toEqual(canonical((await scan({ dataDir, useCache: false })).entries));
    expect(r.entries.find((e) => e.h === 'r-1:req-r-1')?.o).toBe(2);
    expect(r.entries.find((e) => e.h === 'r-2:req-r-2')).toBeUndefined();
  });

  it('finishes a migration that a crash interrupted', async () => {
    const deletedPath = join(dataDir, '-p-alpha', 'deleted.jsonl');
    const legacyRecord = (o: number) => ({
      path: deletedPath,
      size: 100,
      mtimeMs: 1,
      entries: [{ t: 1, p: '', s: 'sess-gone', m: 'claude-sonnet-4-6', i: 1, o, cc: 0, cr: 0, f: 0, h: 'gone:1' }],
      sessionId: 'sess-gone',
    });
    const legacy = join(root, 'cache.json');
    await writeFile(legacy, JSON.stringify({ version: 4, files: { [deletedPath]: legacyRecord(2) } }));
    // One shard already written by the interrupted run, newer than the legacy copy.
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'partial.json'),
      JSON.stringify({ version: 4, key: '-p-alpha', files: { [deletedPath]: legacyRecord(7) } }),
    );
    await writeFile(join(cacheDir, 'stale.json.123.tmp'), '{"half":');

    const r = await scan({ dataDir, cachePath: cacheDir });
    expect(r.entries.find((e) => e.s === 'sess-gone')?.o).toBe(7);
    await flushCacheWrites();
    expect(await stat(legacy).catch(() => null)).toBeNull();
    expect((await readdir(cacheDir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('keeps an unreadable shard aside instead of overwriting it', async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'broken.json'), '{"version":4,"key":');
    await writeFile(join(dataDir, '-p-alpha', 'a.jsonl'), `${usageLine('c-1', 1)}\n`);

    const r = await scan({ dataDir, cachePath: cacheDir });
    expect(r.entries.length).toBe(1);
    await flushCacheWrites();
    expect(await readFile(join(cacheDir, 'broken.json.corrupt'), 'utf-8')).toBe('{"version":4,"key":');
  });

  it('finds transcript files through the shard cache', async () => {
    const path = join(dataDir, '-p-alpha', 't.jsonl');
    await writeFile(path, `${usageLine('t-1', 1, { sessionId: 'sess-T' })}\n`);
    await scan({ dataDir, cachePath: cacheDir });

    const transcript = await readTranscript('sess-T', { dataDir, cachePath: cacheDir });
    expect(transcript.missingRaw).toBe(false);
    expect(transcript.streams.map((stream) => stream.path)).toEqual([join('-p-alpha', 't.jsonl')]);
  });

  it('never mutates entries it already returned when a project is renamed', async () => {
    // No cwd yet: the dir name falls back to its last segment.
    await writeFile(join(dataDir, '-p-alpha', 'a.jsonl'), `${usageLine('n-1', 1, { cwd: undefined })}\n`);
    const first = await scan({ dataDir, cachePath: cacheDir });
    const returned = first.entries.find((e) => e.h === 'n-1:req-n-1')!;
    expect(returned.p).toBe('alpha');

    await writeFile(join(dataDir, '-p-alpha', 'b.jsonl'), `${usageLine('n-2', 1, { cwd: '/home/user/real-name' })}\n`);
    const second = await scan({ dataDir, cachePath: cacheDir });
    expect(returned.p).toBe('alpha');
    expect(new Set(second.entries.map((e) => e.p))).toEqual(new Set(['real-name']));
    expect(second.entries).not.toContain(returned);
  });
});
