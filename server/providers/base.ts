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

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/**
 * Await every in-flight background `saveCache` write. Callers that fire
 * writes via `void saveCache(...)` (to avoid blocking response latency)
 * use this to drain them before tearing down — e.g. tests removing their
 * temp dir, or a graceful shutdown — so a write doesn't land after the
 * directory is gone (ENOENT) and surface as an unhandled rejection.
 */
export async function flushCacheWrites(): Promise<void> {
  await Promise.allSettled([...pendingWrites.values()]);
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
 * we should re-parse from scratch to be safe. The tail starts at the
 * record's `offset` (end of the last complete line), not at its size.
 */
export function decideFileState<T>(
  info: FileInfo,
  cached: FileCacheRecord<T> | undefined,
): FileState<T> {
  if (!cached) return { kind: 'cold' };
  if (cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return { kind: 'unchanged', cached };
  }
  const fromOffset = cached.offset ?? cached.size;
  if (info.size > cached.size && info.size >= fromOffset && cached.mtimeMs <= info.mtimeMs) {
    return { kind: 'appended', cached, fromOffset };
  }
  return { kind: 'cold' };
}

const READ_CHUNK_BYTES = 1024 * 1024;

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Line reader for append-only JSONL logs that tracks where to resume.
 *
 * `endOffset` is the byte offset just past the last complete line yielded.
 * A final line without a trailing newline is yielded only when it is valid
 * JSON; otherwise it is a write in progress, so it is not yielded and
 * `endOffset` stays at its start, letting the next tail read pick it up whole.
 */
export class JsonlLines implements AsyncIterable<string> {
  endOffset: number;

  constructor(
    private readonly path: string,
    private readonly start: number,
  ) {
    this.endOffset = start;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    const fh = await open(this.path, 'r');
    try {
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      // Bytes of the current line that started in an earlier chunk.
      let carry: Buffer[] = [];
      let pos = this.start;
      while (true) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        const chunkStart = pos;
        pos += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        let lineStart = 0;
        let nl: number;
        while ((nl = chunk.indexOf(0x0a, lineStart)) !== -1) {
          let line: Buffer = chunk.subarray(lineStart, nl);
          if (carry.length > 0) {
            carry.push(line);
            line = Buffer.concat(carry);
            carry = [];
          }
          lineStart = nl + 1;
          this.endOffset = chunkStart + lineStart;
          const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
          yield line.toString('utf-8', 0, end);
        }
        // `buf` is reused by the next read, so the partial tail must be copied.
        if (lineStart < bytesRead) carry.push(Buffer.from(chunk.subarray(lineStart)));
      }
      if (carry.length > 0) {
        const last = Buffer.concat(carry).toString('utf-8');
        if (isJson(last)) {
          this.endOffset = pos;
          yield last;
        }
      }
    } finally {
      await fh.close();
    }
  }
}

function shardFileName(key: string): string {
  return `${createHash('sha1').update(key).digest('hex')}.json`;
}

type ShardFile<T> = {
  version: number;
  key: string;
  files: Record<string, FileCacheRecord<T>>;
};

/**
 * Cache split into shards, one JSON file per shard key, so a scan rewrites
 * only the shards whose records changed. Records are looked up by path; the
 * caller decides which shard a record belongs to.
 */
export class ShardedCache<T> {
  private readonly shards = new Map<string, Map<string, FileCacheRecord<T>>>();
  private readonly shardOfPath = new Map<string, string>();
  /** Shard keys with changes not yet written. */
  readonly dirty = new Set<string>();
  /** Single-file cache this one was migrated from; removed after the first full save. */
  legacyPath: string | undefined;

  get(path: string): FileCacheRecord<T> | undefined {
    const key = this.shardOfPath.get(path);
    return key === undefined ? undefined : this.shards.get(key)?.get(path);
  }

  set(key: string, record: FileCacheRecord<T>): void {
    const previousKey = this.shardOfPath.get(record.path);
    if (previousKey !== undefined && previousKey !== key) {
      this.shards.get(previousKey)?.delete(record.path);
      this.dirty.add(previousKey);
    }
    let shard = this.shards.get(key);
    if (!shard) {
      shard = new Map();
      this.shards.set(key, shard);
    }
    shard.set(record.path, record);
    this.shardOfPath.set(record.path, key);
    this.dirty.add(key);
  }

  *records(): IterableIterator<FileCacheRecord<T>> {
    for (const shard of this.shards.values()) yield* shard.values();
  }

  get size(): number {
    return this.shardOfPath.size;
  }

  /** Serialized shard, or undefined when nothing is left in it. */
  serialize(key: string, version: number): string | undefined {
    const shard = this.shards.get(key);
    if (!shard || shard.size === 0) return undefined;
    const file: ShardFile<T> = { version, key, files: Object.fromEntries(shard) };
    return JSON.stringify(file);
  }
}

const shardedCaches = new Map<string, ShardedCache<unknown>>();

/**
 * Load every shard under `dir`, memoized per process like `loadCache`.
 * Unreadable shards and shards of another version are skipped, so their
 * files get re-parsed. When `legacyPath` (the old single-file cache) still
 * exists, its records are migrated first and shards override them: the
 * legacy file is only deleted once every shard has been written.
 */
export async function loadShardedCache<T>(
  dir: string,
  version: number,
  legacyPath: string,
  keyOf: (path: string) => string,
): Promise<ShardedCache<T>> {
  const memo = shardedCaches.get(dir);
  if (memo) return memo as ShardedCache<T>;

  const cache = new ShardedCache<T>();
  const legacy = await readLegacyCache<T>(legacyPath, version);
  if (legacy) {
    for (const record of Object.values(legacy.files)) cache.set(keyOf(record.path), record);
    cache.legacyPath = legacyPath;
  }

  const names = await readdir(dir).catch(() => [] as string[]);
  const shards = await pMap(
    names.filter((name) => name.endsWith('.json')),
    16,
    async (name) => readShard<T>(join(dir, name), version),
  );
  for (const shard of shards) {
    if (!shard) continue;
    for (const record of Object.values(shard.files)) cache.set(shard.key, record);
  }
  // Shards just read match the disk; only a migration leaves work to write.
  if (!legacy) cache.dirty.clear();

  shardedCaches.set(dir, cache as ShardedCache<unknown>);
  return cache;
}

async function readLegacyCache<T>(path: string, version: number): Promise<CacheFile<T> | undefined> {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (raw == null) return undefined;
  try {
    const data = JSON.parse(raw) as CacheFile<T>;
    return data?.version === version && data.files ? data : undefined;
  } catch {
    return undefined;
  }
}

async function readShard<T>(path: string, version: number): Promise<ShardFile<T> | undefined> {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (raw == null) return undefined;
  try {
    const data = JSON.parse(raw) as ShardFile<T>;
    return data?.version === version && typeof data.key === 'string' && data.files ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the dirty shards of `cache` in the background, serialized per `dir`
 * like `saveCache`. Each shard is written to a temp file and renamed so a
 * crash never leaves a truncated shard. Shards that fail stay dirty.
 */
export function saveShardedCache<T>(dir: string, version: number, cache: ShardedCache<T>): Promise<void> {
  const prev = pendingWrites.get(dir) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    // Let the scan's caller respond before serializing blocks the event loop.
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(async () => {
      const keys = [...cache.dirty];
      if (keys.length === 0) return;
      cache.dirty.clear();
      let failed = false;
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        for (const key of keys) cache.dirty.add(key);
        return;
      }
      for (const key of keys) {
        const path = join(dir, shardFileName(key));
        try {
          const body = cache.serialize(key, version);
          if (body === undefined) {
            await unlink(path).catch(() => undefined);
            continue;
          }
          const tmp = `${path}.${process.pid}.tmp`;
          await writeFile(tmp, body);
          await rename(tmp, path);
        } catch {
          cache.dirty.add(key);
          failed = true;
        }
      }
      if (!failed && cache.legacyPath) {
        await unlink(cache.legacyPath).catch(() => undefined);
        cache.legacyPath = undefined;
      }
    });
  pendingWrites.set(dir, next);
  next.finally(() => {
    if (pendingWrites.get(dir) === next) pendingWrites.delete(dir);
  }).catch(() => undefined);
  return next;
}
