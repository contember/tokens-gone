import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { flushCacheWrites, loadCache, saveCache } from '../server/providers/base';
import type { CacheFile } from '../server/providers/types';

let dir: string;

const previous: CacheFile = {
  version: 1,
  files: { '/logs/a.jsonl': { path: '/logs/a.jsonl', size: 10, mtimeMs: 1, entries: [] } },
};

/** Pid of a process that has already exited. */
function deadPid(): number {
  const child = Bun.spawnSync(['true']);
  return child.pid;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccdash-cache-'));
});

afterAll(async () => {
  await flushCacheWrites();
  await rm(dir, { recursive: true, force: true });
});

describe('provider cache file', () => {
  it('keeps the previous cache readable and removes the temp file of a killed write on the next start', async () => {
    const cachePath = join(dir, 'killed', 'cache.json');
    await mkdir(join(dir, 'killed'));
    await writeFile(cachePath, JSON.stringify(previous));
    // What a writer killed mid-write leaves behind: a truncated temp file.
    const stale = `${cachePath}.${deadPid()}.tmp`;
    await writeFile(stale, JSON.stringify({ version: 1, files: {} }).slice(0, 12));
    // A concurrent writer that is still running keeps its temp file.
    const live = `${cachePath}.${process.ppid}.tmp`;
    await writeFile(live, '{');

    const loaded = await loadCache(cachePath, 1);

    expect(loaded).toEqual(previous);
    expect((await readdir(join(dir, 'killed'))).sort()).toEqual(['cache.json', `cache.json.${process.ppid}.tmp`]);
  });

  it('removes an old temp file even when its pid now belongs to a running process', async () => {
    const cachePath = join(dir, 'reused', 'cache.json');
    await mkdir(join(dir, 'reused'));
    await writeFile(cachePath, JSON.stringify(previous));
    const reused = `${cachePath}.${process.ppid}.tmp`;
    await writeFile(reused, '{');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(reused, twoHoursAgo, twoHoursAgo);

    await loadCache(cachePath, 1);

    expect(await readdir(join(dir, 'reused'))).toEqual(['cache.json']);
  });

  it('never writes the cache file in place', async () => {
    const cachePath = join(dir, 'failed', 'cache.json');
    await mkdir(join(dir, 'failed'));
    await writeFile(cachePath, JSON.stringify(previous));
    // Make the temp file unwritable so the write fails before the rename.
    await mkdir(`${cachePath}.${process.pid}.tmp`);

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Background callers do not await it, so a failure must not reject.
      await saveCache(cachePath, { version: 1, files: {} });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    expect(JSON.parse(await readFile(cachePath, 'utf-8'))).toEqual(previous);
  });

  it('replaces the cache and leaves no temp file after a write', async () => {
    const cachePath = join(dir, 'ok', 'cache.json');
    const next: CacheFile = { version: 1, files: {} };

    await saveCache(cachePath, next);

    expect(JSON.parse(await readFile(cachePath, 'utf-8'))).toEqual(next);
    expect(await readdir(join(dir, 'ok'))).toEqual(['cache.json']);
  });
});
