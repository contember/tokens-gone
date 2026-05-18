/**
 * Shared low-level helpers used by every provider:
 *   - `pMap`   — bounded-concurrency map (ulimit safety on macOS)
 *   - `listJsonlFiles` — recursive walker that yields *.jsonl paths
 *   - `loadCache` / `saveCache` — disk-cache I/O with versioned envelope
 *
 * Providers also share an "incremental scan" workflow: for each file,
 * decide whether it's unchanged (reuse), appended (parse tail), or
 * invalidated (full re-parse). That decision is identical across
 * providers and is captured in `decideFileState`.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import type { CacheFile, FileCacheRecord } from './types.ts';

/**
 * Map-with-concurrency-limit. Avoids opening 5000 file descriptors at once,
 * which on Linux is fine but on macOS hits ulimit at 256.
 */
export async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Recursively collect every `*.jsonl` file under `root`. Errors on unreadable
 * directories are swallowed — a deleted/permission-denied subdir shouldn't
 * fail the whole scan.
 */
export async function listJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
    try {
      const raw = await readdir(dir, { withFileTypes: true });
      entries = raw.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
      }));
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile && e.name.endsWith('.jsonl')) {
        out.push(full);
      } else if (e.isDirectory) {
        subdirs.push(full);
      }
    }
    await Promise.all(subdirs.map(walk));
  }

  await walk(root);
  return out;
}

/**
 * Memoized cache layer. Both `loadCache` and `saveCache` keep an
 * in-process mirror keyed by `cachePath`, so repeated scans inside the
 * same process don't pay the disk round-trip + JSON.parse / stringify
 * cost on a 30MB+ file. The on-disk copy is still the source of truth
 * across process restarts; the in-memory copy is what subsequent
 * `loadCache` calls return until the process exits.
 */
const inMemoryCache = new Map<string, CacheFile<unknown>>();

export async function loadCache<T>(
  cachePath: string,
  expectedVersion: number,
): Promise<CacheFile<T>> {
  const cached = inMemoryCache.get(cachePath);
  if (cached && cached.version === expectedVersion) {
    return cached as CacheFile<T>;
  }
  try {
    const raw = await readFile(cachePath, 'utf-8').catch(() => null);
    if (raw == null) {
      const empty: CacheFile<T> = { version: expectedVersion, files: {} };
      inMemoryCache.set(cachePath, empty);
      return empty;
    }
    const data = JSON.parse(raw) as CacheFile<T>;
    if (data?.version !== expectedVersion) {
      const empty: CacheFile<T> = { version: expectedVersion, files: {} };
      inMemoryCache.set(cachePath, empty);
      return empty;
    }
    inMemoryCache.set(cachePath, data);
    return data;
  } catch {
    const empty: CacheFile<T> = { version: expectedVersion, files: {} };
    inMemoryCache.set(cachePath, empty);
    return empty;
  }
}

/**
 * Track the latest in-flight write per cachePath so concurrent saves
 * serialize cleanly instead of racing each other (two writers
 * stringifying and overlapping their writes corrupt the file).
 */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Update both layers of the cache. The in-memory copy is set
 * synchronously so the very next `loadCache` reflects the change; the
 * disk write is chained onto any in-flight write for the same path so
 * we never overlap two writers on the same file. The returned promise
 * resolves only once *this* save has hit disk — but callers who care
 * about response latency more than write durability can run it in the
 * background via `void saveCache(...)` and rely on the in-memory
 * mirror until next time.
 */
export async function saveCache<T>(cachePath: string, cache: CacheFile<T>): Promise<void> {
  inMemoryCache.set(cachePath, cache as CacheFile<unknown>);
  const prev = pendingWrites.get(cachePath) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(cache));
    });
  pendingWrites.set(cachePath, next);
  // Clean up the map once this write is done so the Map doesn't pin
  // outdated promises forever.
  next.finally(() => {
    if (pendingWrites.get(cachePath) === next) pendingWrites.delete(cachePath);
  });
  await next;
}

export type FileInfo = { path: string; size: number; mtimeMs: number };

export type FileState<T> =
  /** Cached file is byte-identical — return its entries verbatim. */
  | { kind: 'unchanged'; cached: FileCacheRecord<T> }
  /** File grew — parse the tail starting at `fromOffset`. */
  | { kind: 'appended'; cached: FileCacheRecord<T>; fromOffset: number }
  /** Cold or invalidated — full re-parse. */
  | { kind: 'cold' };

/**
 * Decide how to handle a file given its cache record and current stat.
 *
 * "Appended" requires the file to have grown AND mtime to not have moved
 * backwards — a backwards mtime usually means the file was rewritten and
 * we should re-parse from scratch to be safe.
 */
export function decideFileState<T>(
  info: FileInfo,
  cached: FileCacheRecord<T> | undefined,
): FileState<T> {
  if (!cached) return { kind: 'cold' };
  if (cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return { kind: 'unchanged', cached };
  }
  if (info.size > cached.size && cached.mtimeMs <= info.mtimeMs) {
    return { kind: 'appended', cached, fromOffset: cached.size };
  }
  return { kind: 'cold' };
}
