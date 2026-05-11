/**
 * Codex CLI session scanner.
 *
 * Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — one JSONL per
 * Codex session — and produces the same `Entry` shape the Claude scanner
 * emits, so the dashboard can treat both sources uniformly.
 *
 * Codex JSONL anatomy (relevant subset):
 *  - `session_meta` (once): session id, cwd, originator, cli_version
 *  - `turn_context` (per turn): model, effort, optional cwd override
 *  - `event_msg` with `payload.type`:
 *      - `user_message`     → first one becomes the session's firstPrompt
 *      - `token_count`      → emit an Entry from `info.last_token_usage`
 *                             (NOT `total_token_usage` — that's cumulative)
 *
 * Token mapping into our Entry shape:
 *   i  = input_tokens - cached_input_tokens   // non-cached input
 *   o  = output_tokens                         // reasoning already included
 *   cc = 0                                     // codex doesn't track cache writes
 *   cr = cached_input_tokens                   // cache read
 *
 * Older codex versions (≤ ~0.6) didn't log token_count at all; those
 * sessions parse cleanly but contribute zero entries.
 */

import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Entry, SessionMeta } from './types.ts';

const CACHE_VERSION = 1;
const MAX_PROMPT_CHARS = 200;

type CodexFileCacheRecord = {
  path: string;
  size: number;
  mtimeMs: number;
  entries: Entry[];
  sessionId?: string;
  firstPrompt?: string;
};

type CodexCacheFile = {
  version: number;
  files: Record<string, CodexFileCacheRecord>;
};

export type CodexScanResult = {
  entries: Entry[];
  sessionMeta: Record<string, SessionMeta>;
  stats: {
    files: number;
    cachedFiles: number;
    parsedLines: number;
    tookMs: number;
  };
};

export function defaultCodexSessionsDir(): string {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'sessions')
    : join(homedir(), '.codex', 'sessions');
}

export function defaultCodexCachePath(): string {
  return join(homedir(), '.cache', 'tokens-gone', 'codex-cache.json');
}

export function codexSessionsExist(dir = defaultCodexSessionsDir()): boolean {
  return existsSync(dir);
}

function projectNameFromCwd(cwd: string): string {
  // Codex stores raw posix/windows paths in session_meta.cwd; take the last
  // non-empty segment.
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

async function listJsonlFiles(root: string): Promise<string[]> {
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

type ParsedFile = {
  entries: Entry[];
  lines: number;
  sessionId?: string;
  firstPrompt?: string;
};

/**
 * Streaming parse of a single codex rollout JSONL.
 *
 * Codex files are smaller than Claude's (no streaming-chunk inflation) but
 * we still stream line-by-line so memory stays flat and incremental tail
 * reads work the same way.
 */
async function parseFile(path: string, fromOffset: number, primed?: {
  sessionId?: string;
  projectName?: string;
  currentModel?: string;
  firstPrompt?: string;
}): Promise<ParsedFile> {
  let lines = 0;
  const entries: Entry[] = [];
  let sessionId = primed?.sessionId;
  let projectName = primed?.projectName;
  let currentModel = primed?.currentModel;
  let firstPrompt = primed?.firstPrompt;

  const stream = createReadStream(path, { encoding: 'utf-8', start: fromOffset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lines++;
    if (line.length < 30) continue;

    // Cheap pre-filter: skip lines that can't possibly hold any of the four
    // record types we care about. Saves JSON.parse on the bulk of the file
    // (response_item / exec_command_end / reasoning blocks).
    const interesting =
      line.indexOf('"session_meta"') !== -1 ||
      line.indexOf('"turn_context"') !== -1 ||
      line.indexOf('"token_count"') !== -1 ||
      line.indexOf('"user_message"') !== -1;
    if (!interesting) continue;

    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }

    const type: string | undefined = json?.type;
    const payload = json?.payload;
    if (!payload) continue;

    if (type === 'session_meta') {
      if (!sessionId && typeof payload.id === 'string') sessionId = payload.id;
      if (!projectName && typeof payload.cwd === 'string') {
        projectName = projectNameFromCwd(payload.cwd);
      }
      continue;
    }

    if (type === 'turn_context') {
      // The model can change mid-session (rare, but possible if the user
      // switches models). We track the most recent one and stamp it onto
      // subsequent token_count entries.
      if (typeof payload.model === 'string' && payload.model) {
        currentModel = payload.model;
      }
      // Some sessions override cwd per turn (sub-shells, sandbox roots).
      // Keep the session-wide project name unless we never got one from
      // session_meta.
      if (!projectName && typeof payload.cwd === 'string') {
        projectName = projectNameFromCwd(payload.cwd);
      }
      continue;
    }

    if (type === 'event_msg') {
      const pType: string | undefined = payload.type;

      if (pType === 'user_message' && !firstPrompt) {
        const msg = payload.message;
        if (typeof msg === 'string') {
          const t = msg.trim();
          if (t) firstPrompt = t.slice(0, MAX_PROMPT_CHARS);
        }
        continue;
      }

      if (pType === 'token_count') {
        const last = payload.info?.last_token_usage;
        if (!last) continue;
        const ts: string | undefined = json.timestamp;
        if (!ts) continue;
        const t = Date.parse(ts);
        if (!Number.isFinite(t)) continue;

        const input: number = last.input_tokens ?? 0;
        const cachedInput: number = last.cached_input_tokens ?? 0;
        const output: number = last.output_tokens ?? 0;
        // Skip empty pulses: codex sometimes emits token_count events with
        // zero deltas (e.g. for tool-use turns that didn't call the LLM).
        if (input === 0 && cachedInput === 0 && output === 0) continue;

        entries.push({
          t,
          p: projectName ?? 'unknown',
          s: sessionId ?? '',
          m: currentModel ?? 'unknown',
          // Non-cached input = total input minus cached portion. Clamp to
          // zero in case codex ever reports cached > input (shouldn't, but
          // we'd rather count zero than negative).
          i: Math.max(0, input - cachedInput),
          o: output,
          cc: 0,
          cr: cachedInput,
          f: 0,
          src: 'codex',
        });
      }
    }
  }

  return { entries, lines, sessionId, firstPrompt };
}

async function loadCache(cachePath: string): Promise<CodexCacheFile> {
  try {
    const raw = await readFile(cachePath, 'utf-8').catch(() => null);
    if (raw == null) return { version: CACHE_VERSION, files: {} };
    const data = JSON.parse(raw) as CodexCacheFile;
    if (data?.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, files: {} };
    }
    return data;
  } catch {
    return { version: CACHE_VERSION, files: {} };
  }
}

async function saveCache(cachePath: string, cache: CodexCacheFile): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache));
}

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

export type CodexScanOptions = {
  sessionsDir?: string;
  cachePath?: string;
  useCache?: boolean;
  concurrency?: number;
};

export async function scanCodex(options: CodexScanOptions = {}): Promise<CodexScanResult> {
  const t0 = performance.now();
  const sessionsDir = options.sessionsDir ?? defaultCodexSessionsDir();
  const cachePath = options.cachePath ?? defaultCodexCachePath();
  const useCache = options.useCache !== false;
  const concurrency = options.concurrency ?? 16;

  if (!existsSync(sessionsDir)) {
    return {
      entries: [],
      sessionMeta: {},
      stats: { files: 0, cachedFiles: 0, parsedLines: 0, tookMs: 0 },
    };
  }

  const [files, cache] = await Promise.all([
    listJsonlFiles(sessionsDir),
    useCache
      ? loadCache(cachePath)
      : Promise.resolve({ version: CACHE_VERSION, files: {} as Record<string, CodexFileCacheRecord> }),
  ]);

  let cachedFiles = 0;
  let parsedLines = 0;
  const allEntries: Entry[] = [];
  const newFiles: Record<string, CodexFileCacheRecord> = {};
  const sessionMeta: Record<string, SessionMeta> = {};

  const fileStats = await pMap(files, concurrency, async (path) => {
    try {
      const s = await stat(path);
      return { path, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  });

  await pMap(
    fileStats.filter((x): x is NonNullable<typeof x> => x !== null),
    concurrency,
    async (info) => {
      const cached = cache.files[info.path];

      // Unchanged file — reuse cache.
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        newFiles[info.path] = cached;
        cachedFiles++;
        for (const e of cached.entries) allEntries.push(e);
        if (cached.sessionId && cached.firstPrompt) {
          sessionMeta[cached.sessionId] = { firstPrompt: cached.firstPrompt };
        }
        return;
      }

      // Appended file — parse only the new tail. Codex JSONLs are append-
      // only during a live session, so this is the common case for the
      // currently-running session.
      //
      // Tail parsing carries forward sessionId / projectName / firstPrompt
      // from the cached prefix (they were set near the top of the file)
      // but NOT currentModel — turn_context can appear mid-file, so we'd
      // need to re-scan to learn it. As a pragmatic fallback we derive
      // currentModel from the most recent cached entry's model.
      if (cached && info.size > cached.size && cached.mtimeMs <= info.mtimeMs) {
        const lastCachedEntry = cached.entries[cached.entries.length - 1];
        const parsed = await parseFile(info.path, cached.size, {
          sessionId: cached.sessionId,
          firstPrompt: cached.firstPrompt,
          currentModel: lastCachedEntry?.m,
        });
        parsedLines += parsed.lines;
        const merged = [...cached.entries, ...parsed.entries];
        const sessionIdMerged = cached.sessionId ?? parsed.sessionId;
        const firstPromptMerged = cached.firstPrompt ?? parsed.firstPrompt;
        const record: CodexFileCacheRecord = {
          path: info.path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          entries: merged,
          sessionId: sessionIdMerged,
          firstPrompt: firstPromptMerged,
        };
        newFiles[info.path] = record;
        for (const e of merged) allEntries.push(e);
        if (sessionIdMerged && firstPromptMerged) {
          sessionMeta[sessionIdMerged] = { firstPrompt: firstPromptMerged };
        }
        return;
      }

      // Cold / invalidated — full parse.
      const parsed = await parseFile(info.path, 0);
      parsedLines += parsed.lines;
      const record: CodexFileCacheRecord = {
        path: info.path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        entries: parsed.entries,
        sessionId: parsed.sessionId,
        firstPrompt: parsed.firstPrompt,
      };
      newFiles[info.path] = record;
      for (const e of parsed.entries) allEntries.push(e);
      if (parsed.sessionId && parsed.firstPrompt) {
        sessionMeta[parsed.sessionId] = { firstPrompt: parsed.firstPrompt };
      }
    },
  );

  if (useCache) {
    await saveCache(cachePath, { version: CACHE_VERSION, files: newFiles });
  }

  allEntries.sort((a, b) => a.t - b.t);

  return {
    entries: allEntries,
    sessionMeta,
    stats: {
      files: files.length,
      cachedFiles,
      parsedLines,
      tookMs: Math.round(performance.now() - t0),
    },
  };
}
