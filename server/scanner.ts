/**
 * JSONL scanner with per-file disk cache.
 *
 * Strategy:
 *  - Cache is keyed by (path, size, mtimeMs). If a file is unchanged, its
 *    parsed entries are reused verbatim — no re-parsing.
 *  - When a file grew (the common case for active sessions), we only parse
 *    the appended tail by seeking to the cached size.
 *  - Anything else (shrunk, mtime moved backwards) triggers a full re-parse.
 *  - Files are processed in parallel with a bounded worker pool to keep CPU
 *    saturated without overwhelming the FS.
 */

import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import type { CacheFile, Entry, FileCacheRecord } from './types.ts';

const CACHE_VERSION = 2;

export type ScanResult = {
  entries: Entry[];
  stats: {
    files: number;
    cachedFiles: number;
    parsedLines: number;
    tookMs: number;
  };
};

export function defaultClaudeProjectsDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(homedir(), '.claude', 'projects');
}

export function defaultCachePath(): string {
  return join(homedir(), '.cache', 'tokens-gone', 'cache.json');
}

/**
 * Resolve a project name for a JSONL file. Project name is the last segment
 * of the encoded cwd dir, which is always the first directory under
 * `projectsDir`. Subagent JSONLs live under deeper subdirs of that project
 * dir, so we walk back to the project root.
 */
export function projectNameForFile(filePath: string, projectsDir: string): string {
  const rel = filePath.startsWith(projectsDir + sep)
    ? filePath.slice(projectsDir.length + 1)
    : filePath;
  const top = rel.split(sep)[0] ?? '';
  if (!top.startsWith('-')) return top || 'unknown';
  const parts = top.slice(1).split('-');
  return parts[parts.length - 1] || top;
}

async function listJsonlFiles(projectsDir: string): Promise<string[]> {
  const result: string[] = [];

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
        result.push(full);
      } else if (e.isDirectory) {
        subdirs.push(full);
      }
    }
    await Promise.all(subdirs.map(walk));
  }

  await walk(projectsDir);
  return result;
}

/**
 * Streaming JSONL parser. Returns extracted entries plus a line count.
 *
 * Streams via readline so we never hold the whole file in memory (some
 * session files are >50MB). A substring pre-filter on `"usage"` skips most
 * non-assistant lines before JSON.parse — the hot path.
 */
async function parseFile(
  path: string,
  projectName: string,
  fromOffset: number,
): Promise<{ entries: Entry[]; lines: number }> {
  let lines = 0;
  const entries: Entry[] = [];
  const stream = createReadStream(path, { encoding: 'utf-8', start: fromOffset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (line.length < 50) continue;
    if (line.indexOf('"usage"') === -1) continue;
    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = json?.message;
    const usage = msg?.usage;
    if (!usage) continue;
    const model: string | undefined = msg.model;
    if (!model || model === '<synthetic>') continue;
    const ts: string | undefined = json.timestamp;
    if (!ts) continue;
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) continue;
    const msgId: string | undefined = msg.id;
    const reqId: string | undefined = json.requestId;
    entries.push({
      t,
      p: projectName,
      s: json.sessionId ?? '',
      m: model,
      i: usage.input_tokens ?? 0,
      o: usage.output_tokens ?? 0,
      cc: usage.cache_creation_input_tokens ?? 0,
      cr: usage.cache_read_input_tokens ?? 0,
      f: usage.speed === 'fast' ? 1 : 0,
      h: msgId && reqId ? `${msgId}:${reqId}` : undefined,
    });
  }
  return { entries, lines };
}

/**
 * Deduplicate by msgId:reqId, keeping the entry with the largest
 * output_tokens. Entries without a hash are kept as-is (we fall back to
 * cross-file structural dedup later for those).
 *
 * Why max output_tokens: streaming responses produce one log line per
 * chunk, each with growing output_tokens. The final chunk is the billed
 * amount. ccusage takes the FIRST chunk and undercounts as a result.
 */
function dedupByHash(entries: Entry[]): Entry[] {
  const byHash = new Map<string, Entry>();
  const out: Entry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!e.h) {
      out.push(e);
      continue;
    }
    const existing = byHash.get(e.h);
    if (!existing || e.o > existing.o) {
      byHash.set(e.h, e);
    }
  }
  byHash.forEach((v) => out.push(v));
  return out;
}

async function loadCache(cachePath: string): Promise<CacheFile> {
  try {
    const raw = await readFile(cachePath, 'utf-8').catch(() => null);
    if (raw == null) return { version: CACHE_VERSION, files: {} };
    const data = JSON.parse(raw) as CacheFile;
    if (data?.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, files: {} };
    }
    return data;
  } catch {
    return { version: CACHE_VERSION, files: {} };
  }
}

async function saveCache(cachePath: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache));
}

/**
 * Map-with-concurrency-limit. Avoids opening 5000 file descriptors at once,
 * which on Linux is fine but on macOS hits ulimit at 256.
 */
async function pMap<T, R>(
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

export type ScanOptions = {
  projectsDir?: string;
  cachePath?: string;
  /** When false, don't read or write the disk cache. */
  useCache?: boolean;
  /** Max parallel file reads. */
  concurrency?: number;
};

export async function scan(options: ScanOptions = {}): Promise<ScanResult> {
  const t0 = performance.now();
  const projectsDir = options.projectsDir ?? defaultClaudeProjectsDir();
  const cachePath = options.cachePath ?? defaultCachePath();
  const useCache = options.useCache !== false;
  const concurrency = options.concurrency ?? 16;

  const files = await listJsonlFiles(projectsDir);
  const cache = useCache
    ? await loadCache(cachePath)
    : { version: CACHE_VERSION, files: {} as Record<string, FileCacheRecord> };

  let cachedFiles = 0;
  let parsedLines = 0;
  const allEntries: Entry[] = [];

  // Build the new cache map as we go so stale entries get dropped.
  const newFiles: Record<string, FileCacheRecord> = {};

  const fileStats = await pMap(files, concurrency, async (path) => {
    try {
      const s = await stat(path);
      return { path, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  });

  await pMap(fileStats.filter((x): x is NonNullable<typeof x> => x !== null), concurrency, async (info) => {
    const cached = cache.files[info.path];
    const projectName = projectNameForFile(info.path, projectsDir);

    // Unchanged file — reuse cache.
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      newFiles[info.path] = cached;
      cachedFiles++;
      for (const e of cached.entries) allEntries.push(e);
      return;
    }

    // Appended file — parse only the tail, then re-dedup with existing entries.
    // The new tail can complete a streaming response whose earlier chunks
    // are already cached, so we merge then dedup-by-hash again.
    if (cached && info.size > cached.size && cached.mtimeMs <= info.mtimeMs) {
      const { entries: tail, lines } = await parseFile(info.path, projectName, cached.size);
      parsedLines += lines;
      const merged = dedupByHash([...cached.entries, ...tail]);
      const record: FileCacheRecord = {
        path: info.path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        entries: merged,
      };
      newFiles[info.path] = record;
      for (const e of merged) allEntries.push(e);
      return;
    }

    // Cold or invalidated — parse the whole file and dedup intra-file.
    const { entries: fresh, lines } = await parseFile(info.path, projectName, 0);
    parsedLines += lines;
    const deduped = dedupByHash(fresh);
    const record: FileCacheRecord = {
      path: info.path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      entries: deduped,
    };
    newFiles[info.path] = record;
    for (const e of deduped) allEntries.push(e);
  });

  if (useCache) {
    await saveCache(cachePath, { version: CACHE_VERSION, files: newFiles });
  }

  // Cross-file dedup: subagent JSONLs replicate their parent session's API
  // calls. Same msgId:reqId → keep the entry with the largest output_tokens
  // (the final chunk in a streamed response). Hashless entries fall back to
  // structural dedup.
  const byHash = new Map<string, Entry>();
  const structSeen = new Set<string>();
  const hashless: Entry[] = [];
  for (let i = 0; i < allEntries.length; i++) {
    const e = allEntries[i]!;
    if (e.h) {
      const existing = byHash.get(e.h);
      if (!existing || e.o > existing.o) byHash.set(e.h, e);
      continue;
    }
    const k = `${e.t}|${e.s}|${e.i}|${e.o}|${e.cc}|${e.cr}`;
    if (structSeen.has(k)) continue;
    structSeen.add(k);
    hashless.push(e);
  }

  const deduped: Entry[] = [];
  byHash.forEach((v) => deduped.push(v));
  for (const e of hashless) deduped.push(e);
  deduped.sort((a, b) => a.t - b.t);

  return {
    entries: deduped,
    stats: {
      files: files.length,
      cachedFiles,
      parsedLines,
      tookMs: Math.round(performance.now() - t0),
    },
  };
}
