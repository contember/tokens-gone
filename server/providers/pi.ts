/**
 * Pi coding agent provider.
 *
 * Reads `~/.pi/agent/sessions/**\/*.jsonl` — one JSONL per Pi session.
 * Pi records a `session` entry followed by `message` entries. Assistant
 * messages carry `usage.{input, output, cacheRead, cacheWrite, cacheWrite1h}`
 * and, when available, authoritative USD cost components in `usage.cost`.
 *
 * Token mapping into our Entry shape:
 *   i  = usage.input
 *   o  = usage.output
 *   cc = usage.cacheWrite + usage.cacheWrite1h
 *   cr = usage.cacheRead
 *
 * Pi can route to many model providers, so we preserve its logged cost
 * components instead of depending solely on this app's static pricing table.
 */

import { stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, sep } from 'node:path';
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

type PiExtra = {
  sessionId?: string;
  firstPrompt?: string;
  summary?: string;
  projectName?: string;
  cwd?: string;
};

type ParsedFile = {
  entries: Entry[];
  lines: number;
  sessionId?: string;
  firstPrompt?: string;
  summary?: string;
  projectName?: string;
  cwd?: string;
};

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function defaultDataDir(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    return expandHome(process.env.PI_CODING_AGENT_SESSION_DIR);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? expandHome(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), '.pi', 'agent');
  return join(agentDir, 'sessions');
}

function defaultCachePath(): string {
  return join(homedir(), '.cache', 'tokens-gone', 'pi-cache.json');
}

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

function fallbackProjectName(filePath: string, sessionsDir: string): string {
  const rel = filePath.startsWith(sessionsDir + sep)
    ? filePath.slice(sessionsDir.length + 1)
    : filePath;
  const encoded = rel.split(sep)[0] ?? '';
  if (!encoded) return 'unknown';
  const unwrapped = encoded.startsWith('--') && encoded.endsWith('--')
    ? encoded.slice(2, -2)
    : encoded;
  const parts = unwrapped.split('-').filter(Boolean);
  return parts[parts.length - 1] || unwrapped || 'unknown';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value: unknown): number {
  return finiteNumber(value) ?? 0;
}

function parseTimestamp(entryTs: unknown, messageTs: unknown): number | undefined {
  const messageMs = finiteNumber(messageTs);
  if (messageMs !== undefined) return messageMs;
  if (typeof entryTs === 'string') {
    const t = Date.parse(entryTs);
    if (Number.isFinite(t)) return t;
  }
  const entryMs = finiteNumber(entryTs);
  if (entryMs !== undefined) return entryMs;
  return undefined;
}

function extractUserText(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string };
      if (typeof b.text === 'string' && (!b.type || b.type === 'text' || b.type === 'input_text')) {
        text = b.text;
        break;
      }
    }
  }
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, MAX_PROMPT_CHARS) : undefined;
}

function addCostFields(entry: Entry, cost: unknown): void {
  if (!cost || typeof cost !== 'object') return;
  const c = cost as Record<string, unknown>;
  const input = finiteNumber(c.input);
  const output = finiteNumber(c.output);
  const cacheRead = finiteNumber(c.cacheRead);
  const cacheWrite = (finiteNumber(c.cacheWrite) ?? 0) + (finiteNumber(c.cacheWrite1h) ?? 0);
  if (input !== undefined) entry.ci = input;
  if (output !== undefined) entry.co = output;
  if (cacheWrite > 0 || c.cacheWrite !== undefined || c.cacheWrite1h !== undefined) {
    entry.cwc = cacheWrite;
  }
  if (cacheRead !== undefined) entry.crc = cacheRead;
}

function addSessionMeta(
  sessionMeta: Record<string, SessionMeta>,
  sessionId: string | undefined,
  summary: string | undefined,
  firstPrompt: string | undefined,
): void {
  if (!sessionId || (!summary && !firstPrompt)) return;
  sessionMeta[sessionId] = { summary, firstPrompt };
}

async function parseFile(
  path: string,
  sessionsDir: string,
  fromOffset: number,
  primed?: {
    sessionId?: string;
    projectName?: string;
    firstPrompt?: string;
    summary?: string;
    cwd?: string;
  },
): Promise<ParsedFile> {
  let lines = 0;
  const entries: Entry[] = [];
  let sessionId = primed?.sessionId;
  let projectName = primed?.projectName;
  let firstPrompt = primed?.firstPrompt;
  let summary = primed?.summary;
  let cwd = primed?.cwd;

  const stream = createReadStream(path, { encoding: 'utf-8', start: fromOffset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lines++;
    if (line.length < 20) continue;

    const interesting =
      line.indexOf('"type":"session"') !== -1 ||
      line.indexOf('"type":"message"') !== -1 ||
      line.indexOf('"type":"session_info"') !== -1;
    if (!interesting) continue;

    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }

    const type: string | undefined = json?.type;

    if (type === 'session') {
      const session = json.session && typeof json.session === 'object' ? json.session : json;
      if (!sessionId && typeof session.id === 'string') sessionId = session.id;
      if (!cwd && typeof session.cwd === 'string' && session.cwd) {
        cwd = session.cwd;
        projectName = projectNameFromCwd(session.cwd);
      }
      continue;
    }

    if (type === 'session_info') {
      const name = typeof json.name === 'string'
        ? json.name.trim()
        : typeof json.sessionInfo?.name === 'string'
          ? json.sessionInfo.name.trim()
          : undefined;
      if (name) summary = name.slice(0, MAX_PROMPT_CHARS);
      continue;
    }

    if (type !== 'message') continue;
    const msg = json.message;
    if (!msg || typeof msg !== 'object') continue;

    if (!sessionId && typeof json.sessionId === 'string') sessionId = json.sessionId;

    if (!firstPrompt && msg.role === 'user') {
      firstPrompt = extractUserText(msg.content);
      continue;
    }

    if (msg.role !== 'assistant') continue;
    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') continue;

    const input = numberOrZero(usage.input);
    const output = numberOrZero(usage.output);
    const cacheRead = numberOrZero(usage.cacheRead);
    const cacheWrite = numberOrZero(usage.cacheWrite) + numberOrZero(usage.cacheWrite1h);

    const t = parseTimestamp(json.timestamp, msg.timestamp);
    if (t === undefined) continue;

    const model = typeof msg.responseModel === 'string' && msg.responseModel
      ? msg.responseModel
      : typeof msg.model === 'string' && msg.model
        ? msg.model
        : 'unknown';

    const entry: Entry = {
      t,
      p: projectName ?? fallbackProjectName(path, sessionsDir),
      s: sessionId ?? '',
      m: model,
      i: input,
      o: output,
      cc: cacheWrite,
      cr: cacheRead,
      f: 0,
      src: 'pi',
    };
    addCostFields(entry, usage.cost);

    const hasTokens = input !== 0 || output !== 0 || cacheRead !== 0 || cacheWrite !== 0;
    const hasCost =
      entry.ci !== undefined ||
      entry.co !== undefined ||
      entry.cwc !== undefined ||
      entry.crc !== undefined;
    if (hasTokens || hasCost) entries.push(entry);
  }

  return { entries, lines, sessionId, firstPrompt, summary, projectName, cwd };
}

async function scanPi(options: ProviderScanOptions = {}): Promise<ProviderScanResult> {
  const t0 = performance.now();
  const sessionsDir = options.dataDir ?? defaultDataDir();
  const cachePath = options.cachePath ?? defaultCachePath();
  const useCache = options.useCache !== false;
  const concurrency = options.concurrency ?? 16;

  if (!existsSync(sessionsDir)) return emptyResult();

  const [files, cache] = await Promise.all([
    listJsonlFiles(sessionsDir),
    useCache
      ? loadCache<PiExtra>(cachePath, CACHE_VERSION)
      : Promise.resolve({
          version: CACHE_VERSION,
          files: {} as Record<string, FileCacheRecord<PiExtra>>,
        }),
  ]);

  let cachedFiles = 0;
  let parsedLines = 0;
  const allEntries: Entry[] = [];
  const newFiles: Record<string, FileCacheRecord<PiExtra>> = {};
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
      const state = decideFileState<PiExtra>(info, cache.files[info.path]);

      if (state.kind === 'unchanged') {
        newFiles[info.path] = state.cached;
        cachedFiles++;
        for (const e of state.cached.entries) allEntries.push(e);
        addSessionMeta(
          sessionMeta,
          state.cached.sessionId,
          state.cached.summary,
          state.cached.firstPrompt,
        );
        return;
      }

      if (state.kind === 'appended') {
        const parsed = await parseFile(info.path, sessionsDir, state.fromOffset, {
          sessionId: state.cached.sessionId,
          projectName: state.cached.projectName,
          firstPrompt: state.cached.firstPrompt,
          summary: state.cached.summary,
          cwd: state.cached.cwd,
        });
        parsedLines += parsed.lines;
        const merged = [...state.cached.entries, ...parsed.entries];
        const sessionIdMerged = state.cached.sessionId ?? parsed.sessionId;
        const firstPromptMerged = state.cached.firstPrompt ?? parsed.firstPrompt;
        const summaryMerged = parsed.summary ?? state.cached.summary;
        const projectNameMerged = state.cached.projectName ?? parsed.projectName;
        const cwdMerged = state.cached.cwd ?? parsed.cwd;
        const record: FileCacheRecord<PiExtra> = {
          path: info.path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          entries: merged,
          sessionId: sessionIdMerged,
          firstPrompt: firstPromptMerged,
          summary: summaryMerged,
          projectName: projectNameMerged,
          cwd: cwdMerged,
        };
        newFiles[info.path] = record;
        for (const e of merged) allEntries.push(e);
        addSessionMeta(sessionMeta, sessionIdMerged, summaryMerged, firstPromptMerged);
        return;
      }

      const parsed = await parseFile(info.path, sessionsDir, 0);
      parsedLines += parsed.lines;
      const record: FileCacheRecord<PiExtra> = {
        path: info.path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        entries: parsed.entries,
        sessionId: parsed.sessionId,
        firstPrompt: parsed.firstPrompt,
        summary: parsed.summary,
        projectName: parsed.projectName,
        cwd: parsed.cwd,
      };
      newFiles[info.path] = record;
      for (const e of parsed.entries) allEntries.push(e);
      addSessionMeta(sessionMeta, parsed.sessionId, parsed.summary, parsed.firstPrompt);
    },
  );

  if (useCache) {
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

export const piProvider: Provider = {
  id: 'pi',
  label: 'Pi',
  defaultDataDir,
  defaultCachePath,
  detect: (dir = defaultDataDir()) => existsSync(dir),
  scan: scanPi,
};

export { scanPi as _scanPi };
