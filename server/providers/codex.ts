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
import type { Entry, SessionMeta, SessionTranscript, TranscriptEntry } from '../types.ts';
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
import {
  codexTokens,
  countEntries,
  imagesFromUnknown,
  messageEntries,
  parseTimestampMs,
  providerPath,
  readJsonlObjects,
  recordField,
  roleFromString,
  sortStreams,
  streamLabel,
  stringField,
  textFromUnknown,
} from './transcript.ts';

const CACHE_VERSION = 2;
const MAX_PROMPT_CHARS = 200;

type CodexExtra = {
  sessionId?: string;
  firstPrompt?: string;
  parentSessionId?: string;
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
};

function codexSessionMeta(record: CodexExtra): SessionMeta | undefined {
  const meta: SessionMeta = {};
  let hasAny = false;
  if (record.firstPrompt) {
    meta.firstPrompt = record.firstPrompt;
    hasAny = true;
  }
  if (record.parentSessionId) {
    meta.parentSessionId = record.parentSessionId;
    hasAny = true;
  }
  if (record.threadSource) {
    meta.threadSource = record.threadSource;
    hasAny = true;
  }
  if (record.agentNickname) {
    meta.agentNickname = record.agentNickname;
    hasAny = true;
  }
  if (record.agentRole) {
    meta.agentRole = record.agentRole;
    hasAny = true;
  }
  return hasAny ? meta : undefined;
}

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
  parentSessionId?: string;
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
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
    parentSessionId?: string;
    threadSource?: string;
    agentNickname?: string;
    agentRole?: string;
  },
): Promise<ParsedFile> {
  let lines = 0;
  const entries: Entry[] = [];
  let sessionId = primed?.sessionId;
  let projectName = primed?.projectName;
  let currentModel = primed?.currentModel;
  let firstPrompt = primed?.firstPrompt;
  let parentSessionId = primed?.parentSessionId;
  let threadSource = primed?.threadSource;
  let agentNickname = primed?.agentNickname;
  let agentRole = primed?.agentRole;

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
      if (typeof payload.thread_source === 'string') threadSource = payload.thread_source;
      if (typeof payload.agent_nickname === 'string') agentNickname = payload.agent_nickname;
      if (typeof payload.agent_role === 'string') agentRole = payload.agent_role;
      const parent =
        typeof payload.parent_thread_id === 'string'
          ? payload.parent_thread_id
          : typeof payload.session_id === 'string'
            ? payload.session_id
            : undefined;
      if (parent && parent !== payload.id) parentSessionId = parent;
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

  return { entries, lines, sessionId, firstPrompt, parentSessionId, threadSource, agentNickname, agentRole };
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
        const meta = codexSessionMeta(state.cached);
        if (state.cached.sessionId && meta) {
          sessionMeta[state.cached.sessionId] = meta;
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
          parentSessionId: state.cached.parentSessionId,
          threadSource: state.cached.threadSource,
          agentNickname: state.cached.agentNickname,
          agentRole: state.cached.agentRole,
          currentModel: lastCachedEntry?.m,
        });
        parsedLines += parsed.lines;
        const merged = [...state.cached.entries, ...parsed.entries];
        const sessionIdMerged = state.cached.sessionId ?? parsed.sessionId;
        const firstPromptMerged = state.cached.firstPrompt ?? parsed.firstPrompt;
        const parentSessionIdMerged = state.cached.parentSessionId ?? parsed.parentSessionId;
        const threadSourceMerged = state.cached.threadSource ?? parsed.threadSource;
        const agentNicknameMerged = state.cached.agentNickname ?? parsed.agentNickname;
        const agentRoleMerged = state.cached.agentRole ?? parsed.agentRole;
        const record: FileCacheRecord<CodexExtra> = {
          path: info.path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          entries: merged,
          sessionId: sessionIdMerged,
          firstPrompt: firstPromptMerged,
          parentSessionId: parentSessionIdMerged,
          threadSource: threadSourceMerged,
          agentNickname: agentNicknameMerged,
          agentRole: agentRoleMerged,
        };
        newFiles[info.path] = record;
        for (const e of merged) allEntries.push(e);
        const meta = codexSessionMeta(record);
        if (sessionIdMerged && meta) {
          sessionMeta[sessionIdMerged] = meta;
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
        parentSessionId: parsed.parentSessionId,
        threadSource: parsed.threadSource,
        agentNickname: parsed.agentNickname,
        agentRole: parsed.agentRole,
      };
      newFiles[info.path] = record;
      for (const e of parsed.entries) allEntries.push(e);
      const meta = codexSessionMeta(record);
      if (parsed.sessionId && meta) {
        sessionMeta[parsed.sessionId] = meta;
      }
    },
  );

  if (useCache) {
    // Same skip-when-clean + background-write strategy as the Claude
    // provider — see its comment for the reasoning.
    const fileSetChanged = files.length !== Object.keys(cache.files).length;
    if (parsedLines > 0 || fileSetChanged) {
      void saveCache(cachePath, { version: CACHE_VERSION, files: newFiles });
    }
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

async function readCodexTranscript(
  sessionId: string,
  options: ProviderScanOptions = {},
): Promise<SessionTranscript> {
  const defaultDir = defaultDataDir();
  const sessionsDir = options.dataDir ?? defaultDir;
  const cachePath = options.cachePath ?? defaultCachePath();
  const concurrency = options.concurrency ?? 16;
  const useCacheIndex =
    options.useCache !== false && (options.cachePath !== undefined || sessionsDir === defaultDir);
  if (!existsSync(sessionsDir)) return emptyCodexTranscript(sessionId);

  const files = await transcriptFiles(sessionsDir, cachePath, sessionId, useCacheIndex);
  const streams: SessionTranscript['streams'] = [];

  await pMap(files, concurrency, async (path) => {
    const entries: TranscriptEntry[] = [];
    let fileSessionId: string | undefined;
    let currentModel: string | undefined;
    try {
      await readJsonlObjects(path, (json, lineNo) => {
        const type = stringField(json, 'type');
        const payload = recordField(json, 'payload');
        if (type === 'session_meta' && payload) {
          // Subagent rollouts embed the parent metadata after their own.
          fileSessionId ??= stringField(payload, 'id');
        }
        if (type === 'turn_context' && payload) {
          currentModel = stringField(payload, 'model') ?? currentModel;
        }
        entries.push(...codexLineEntries(json, path, lineNo, currentModel));
      });
    } catch {
      return;
    }
    if (fileSessionId !== sessionId) return;

    const rel = providerPath(sessionsDir, path);
    streams.push({
      id: rel,
      label: streamLabel(rel, 'main'),
      path: rel,
      kind: 'main',
      isSidechain: false,
      entries,
    });
  });

  sortStreams(streams);
  return {
    sessionId,
    provider: 'codex',
    streams,
    sourceFiles: streams.length,
    totalEntries: countEntries(streams),
    missingRaw: streams.length === 0,
  };
}

async function transcriptFiles(
  sessionsDir: string,
  cachePath: string,
  sessionId: string,
  useCache: boolean,
): Promise<string[]> {
  if (useCache) {
    const cache = await loadCache<CodexExtra>(cachePath, CACHE_VERSION);
    const cachedMatches = Object.values(cache.files).filter((record) => record.sessionId === sessionId);
    if (cachedMatches.length > 0) {
      const paths = new Set<string>();
      for (const record of cachedMatches) {
        if (existsSync(record.path)) paths.add(record.path);
      }
      return [...paths];
    }
  }
  return listJsonlFiles(sessionsDir);
}

function emptyCodexTranscript(sessionId: string): SessionTranscript {
  return {
    sessionId,
    provider: 'codex',
    streams: [],
    sourceFiles: 0,
    totalEntries: 0,
    missingRaw: true,
  };
}

function codexLineEntries(
  json: Record<string, unknown>,
  path: string,
  lineNo: number,
  currentModel: string | undefined,
): TranscriptEntry[] {
  const type = stringField(json, 'type') ?? 'event';
  const payload = recordField(json, 'payload');
  const timestamp = parseTimestampMs(json.timestamp);
  const idBase = `${path}:${lineNo}`;

  if (type === 'session_meta') {
    return [{
      id: idBase,
      role: 'system',
      kind: 'event',
      title: 'Session meta',
      rawType: type,
      isSidechain: false,
      isCompactSummary: false,
      t: timestamp,
      text: textFromUnknown(payload ?? json),
      images: imagesFromUnknown(payload ?? json),
    }];
  }

  if (type === 'turn_context') {
    return [{
      id: idBase,
      role: 'system',
      kind: 'event',
      title: currentModel ? `Turn context · ${currentModel}` : 'Turn context',
      rawType: type,
      isSidechain: false,
      isCompactSummary: false,
      t: timestamp,
      text: textFromUnknown(payload ?? json),
      images: imagesFromUnknown(payload ?? json),
      model: currentModel,
    }];
  }

  if (type === 'event_msg' && payload) {
    const payloadType = stringField(payload, 'type') ?? 'event';
    if (payloadType === 'user_message') {
      return messageEntries({
        idBase,
        rawType: `${type}:${payloadType}`,
        role: 'user',
        content: payload.message,
        timestamp,
        model: currentModel,
        isSidechain: false,
        isCompactSummary: false,
      });
    }

    if (payloadType === 'token_count') {
      const info = recordField(payload, 'info');
      const usage = info ? recordField(info, 'last_token_usage') : undefined;
      return [{
        id: idBase,
        role: 'event',
        kind: 'event',
        title: 'Token count',
        rawType: `${type}:${payloadType}`,
        isSidechain: false,
        isCompactSummary: false,
        t: timestamp,
        text: textFromUnknown(info ?? payload),
        images: imagesFromUnknown(info ?? payload),
        model: currentModel,
        tokens: codexTokens(usage),
      }];
    }

    return [{
      id: idBase,
      role: 'event',
      kind: 'event',
      title: `Codex event · ${payloadType}`,
      rawType: `${type}:${payloadType}`,
      isSidechain: false,
      isCompactSummary: false,
      t: timestamp,
      text: textFromUnknown(payload),
      images: imagesFromUnknown(payload),
      model: currentModel,
    }];
  }

  if (type === 'response_item' && payload) {
    const payloadType = stringField(payload, 'type') ?? 'response_item';
    if (payloadType === 'message') {
      return messageEntries({
        idBase,
        rawType: `${type}:${payloadType}`,
        role: roleFromString(stringField(payload, 'role')),
        content: payload.content,
        timestamp,
        model: currentModel,
        isSidechain: false,
        isCompactSummary: false,
      });
    }
    return [{
      id: idBase,
      role: 'event',
      kind: 'event',
      title: `Response item · ${payloadType}`,
      rawType: `${type}:${payloadType}`,
      isSidechain: false,
      isCompactSummary: false,
      t: timestamp,
      text: textFromUnknown(payload),
      images: imagesFromUnknown(payload),
      model: currentModel,
    }];
  }

  return [{
    id: idBase,
    role: 'event',
    kind: 'event',
    title: `Event · ${type}`,
    rawType: type,
    isSidechain: false,
    isCompactSummary: false,
    t: timestamp,
    text: textFromUnknown(payload ?? json),
    images: imagesFromUnknown(payload ?? json),
    model: currentModel,
  }];
}

export const codexProvider: Provider = {
  id: 'codex',
  label: 'Codex',
  defaultDataDir,
  defaultCachePath,
  detect: (dir = defaultDataDir()) => existsSync(dir),
  scan: scanCodex,
  readTranscript: readCodexTranscript,
};

export { readCodexTranscript as _readCodexTranscript, scanCodex as _scanCodex };
