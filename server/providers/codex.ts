/**
 * Codex CLI provider.
 *
 * Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — one JSONL per
 * Codex session.
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

import { stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Entry, SessionMeta } from '../types.ts';
import type {
  Provider,
  ProviderScanOptions,
  ProviderScanResult,
  FileCacheRecord,
} from './types.ts';
import { emptyResult } from './types.ts';
import {
  decideFileState,
  listJsonlFiles,
  loadCache,
  pMap,
  saveCache,
  type FileInfo,
} from './base.ts';

const CACHE_VERSION = 1;
const MAX_PROMPT_CHARS = 200;

type CodexExtra = {
  sessionId?: string;
  firstPrompt?: string;
};

function defaultDataDir(): string {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'sessions')
    : join(homedir(), '.codex', 'sessions');
}

function defaultCachePath(): string {
  return join(homedir(), '.cache', 'tokens-gone', 'codex-cache.json');
}

function projectNameFromCwd(cwd: string): string {
  // Codex stores raw posix/windows paths in session_meta.cwd; take the last
  // non-empty segment.
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
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
async function parseFile(
  path: string,
  fromOffset: number,
  primed?: {
    sessionId?: string;
    projectName?: string;
    currentModel?: string;
    firstPrompt?: string;
  },
): Promise<ParsedFile> {
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
          // zero in case codex ever reports cached > input.
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

async function scanCodex(options: ProviderScanOptions = {}): Promise<ProviderScanResult> {
  const t0 = performance.now();
  const sessionsDir = options.dataDir ?? defaultDataDir();
  const cachePath = options.cachePath ?? defaultCachePath();
  const useCache = options.useCache !== false;
  const concurrency = options.concurrency ?? 16;

  if (!existsSync(sessionsDir)) return emptyResult();

  const [files, cache] = await Promise.all([
    listJsonlFiles(sessionsDir),
    useCache
      ? loadCache<CodexExtra>(cachePath, CACHE_VERSION)
      : Promise.resolve({
          version: CACHE_VERSION,
          files: {} as Record<string, FileCacheRecord<CodexExtra>>,
        }),
  ]);

  let cachedFiles = 0;
  let parsedLines = 0;
  const allEntries: Entry[] = [];
  const newFiles: Record<string, FileCacheRecord<CodexExtra>> = {};
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
    fileStats.filter((x): x is FileInfo => x !== null),
    concurrency,
    async (info) => {
      const state = decideFileState<CodexExtra>(info, cache.files[info.path]);

      if (state.kind === 'unchanged') {
        newFiles[info.path] = state.cached;
        cachedFiles++;
        for (const e of state.cached.entries) allEntries.push(e);
        if (state.cached.sessionId && state.cached.firstPrompt) {
          sessionMeta[state.cached.sessionId] = { firstPrompt: state.cached.firstPrompt };
        }
        return;
      }

      if (state.kind === 'appended') {
        // Tail parsing carries forward sessionId / firstPrompt from the
        // cached prefix (they were set near the top of the file) but NOT
        // currentModel — turn_context can appear mid-file, so we'd need to
        // re-scan to learn it. As a pragmatic fallback we derive currentModel
        // from the most recent cached entry's model.
        const lastCachedEntry = state.cached.entries[state.cached.entries.length - 1];
        const parsed = await parseFile(info.path, state.fromOffset, {
          sessionId: state.cached.sessionId,
          firstPrompt: state.cached.firstPrompt,
          currentModel: lastCachedEntry?.m,
        });
        parsedLines += parsed.lines;
        const merged = [...state.cached.entries, ...parsed.entries];
        const sessionIdMerged = state.cached.sessionId ?? parsed.sessionId;
        const firstPromptMerged = state.cached.firstPrompt ?? parsed.firstPrompt;
        const record: FileCacheRecord<CodexExtra> = {
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
      const record: FileCacheRecord<CodexExtra> = {
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

export const codexProvider: Provider = {
  id: 'codex',
  label: 'Codex',
  defaultDataDir,
  defaultCachePath,
  detect: (dir = defaultDataDir()) => existsSync(dir),
  scan: scanCodex,
};

export { scanCodex as _scanCodex };
