/**
 * Pi-compatible JSONL provider shared by Pi and Oh My Pi.
 *
 * Both harnesses record a `session` entry followed by `message` entries.
 * Assistant messages carry `usage.{input, output, cacheRead, cacheWrite,
 * cacheWrite1h}` and, when available, authoritative USD cost components.
 *
 * Token mapping into our Entry shape:
 *   i  = usage.input
 *   o  = usage.output
 *   cc = usage.cacheWrite + usage.cacheWrite1h
 *   cr = usage.cacheRead
 *
 * These harnesses can route to many model providers, so we preserve logged
 * cost components instead of depending solely on the static pricing table.
 */

import { stat } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Entry, SessionMeta, SessionTranscript, TranscriptEntry } from '../types.ts';
import type {
  Provider,
  ProviderId,
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
  countEntries,
  imagesFromUnknown,
  messageEntries,
  parseTimestampMs,
  piTokens,
  providerPath,
  readJsonlObjects,
  recordField,
  roleFromString,
  sortStreams,
  streamLabel,
  stringField,
  textFromUnknown,
} from './transcript.ts';

const CACHE_VERSION = 1;
const MAX_PROMPT_CHARS = 200;

export type PiJsonlProviderConfig = {
  id: Extract<ProviderId, 'pi' | 'omp'>;
  label: string;
  defaultDataDir(): string;
  defaultCachePath(): string;
};

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

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? expandHome(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), '.pi', 'agent');
}

function resolveConfigPath(path: string, baseDir: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sessionDirFromSettings(agentDir: string): string | undefined {
  try {
    const raw = readFileSync(join(agentDir, 'settings.json'), 'utf-8');
    const settings: unknown = JSON.parse(raw);
    if (!isRecord(settings)) return undefined;
    const sessionDir = settings.sessionDir;
    if (typeof sessionDir !== 'string' || sessionDir.trim() === '') return undefined;
    return resolveConfigPath(sessionDir, agentDir);
  } catch {
    return undefined;
  }
}

function defaultDataDir(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    return expandHome(process.env.PI_CODING_AGENT_SESSION_DIR);
  }
  const agentDir = defaultAgentDir();
  const configuredSessionDir = sessionDirFromSettings(agentDir);
  if (configuredSessionDir) return configuredSessionDir;
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

function dedupKey(e: Entry): string {
  return [
    e.t,
    e.m,
    e.i,
    e.o,
    e.cc,
    e.cr,
    e.ci ?? '',
    e.co ?? '',
    e.cwc ?? '',
    e.crc ?? '',
  ].join('|');
}

function dedupEntries(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const e of entries) {
    const key = dedupKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

async function parseFile(
  path: string,
  sessionsDir: string,
  providerId: PiJsonlProviderConfig['id'],
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
      line.indexOf('"type":"session_info"') !== -1 ||
      line.indexOf('"type":"title"') !== -1;
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

    if (type === 'session_info' || type === 'title') {
      const name = type === 'title'
        ? typeof json.title === 'string' ? json.title.trim() : undefined
        : typeof json.name === 'string'
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
      src: providerId,
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

async function scanPiJsonl(
  config: PiJsonlProviderConfig,
  options: ProviderScanOptions = {},
): Promise<ProviderScanResult> {
  const t0 = performance.now();
  const sessionsDir = options.dataDir ?? config.defaultDataDir();
  const cachePath = options.cachePath ?? config.defaultCachePath();
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
        const parsed = await parseFile(info.path, sessionsDir, config.id, state.fromOffset, {
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

      const parsed = await parseFile(info.path, sessionsDir, config.id, 0);
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

  const deduped = dedupEntries(allEntries);
  deduped.sort((a, b) => a.t - b.t);

  return {
    entries: deduped,
    sessionMeta,
    stats: {
      files: files.length,
      cachedFiles,
      parsedLines,
      tookMs: Math.round(performance.now() - t0),
    },
  };
}

async function readPiJsonlTranscript(
  config: PiJsonlProviderConfig,
  sessionId: string,
  options: ProviderScanOptions = {},
): Promise<SessionTranscript> {
  const defaultDir = config.defaultDataDir();
  const sessionsDir = options.dataDir ?? defaultDir;
  const cachePath = options.cachePath ?? config.defaultCachePath();
  const concurrency = options.concurrency ?? 16;
  const useCacheIndex =
    options.useCache !== false && (options.cachePath !== undefined || sessionsDir === defaultDir);
  if (!existsSync(sessionsDir)) return emptyPiTranscript(config.id, sessionId);

  const files = await transcriptFiles(sessionsDir, cachePath, sessionId, useCacheIndex);
  const streams: SessionTranscript['streams'] = [];

  await pMap(files, concurrency, async (path) => {
    const entries: TranscriptEntry[] = [];
    let fileSessionId: string | undefined;
    try {
      await readJsonlObjects(path, (json, lineNo) => {
        const type = stringField(json, 'type');
        if (type === 'session') {
          const session = recordField(json, 'session') ?? json;
          fileSessionId = stringField(session, 'id') ?? fileSessionId;
        }
        fileSessionId = stringField(json, 'sessionId') ?? fileSessionId;
        entries.push(...piLineEntries(json, path, lineNo));
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
    provider: config.id,
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
    const cache = await loadCache<PiExtra>(cachePath, CACHE_VERSION);
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

function emptyPiTranscript(
  providerId: PiJsonlProviderConfig['id'],
  sessionId: string,
): SessionTranscript {
  return {
    sessionId,
    provider: providerId,
    streams: [],
    sourceFiles: 0,
    totalEntries: 0,
    missingRaw: true,
  };
}

function piLineEntries(
  json: Record<string, unknown>,
  path: string,
  lineNo: number,
): TranscriptEntry[] {
  const type = stringField(json, 'type') ?? 'event';
  const timestamp = parseTimestampMs(json.timestamp);
  const idBase = `${path}:${lineNo}`;

  if (type === 'session') {
    return [{
      id: idBase,
      role: 'system',
      kind: 'event',
      title: 'Session meta',
      rawType: type,
      isSidechain: false,
      isCompactSummary: false,
      t: timestamp,
      text: textFromUnknown(recordField(json, 'session') ?? json),
      images: imagesFromUnknown(recordField(json, 'session') ?? json),
    }];
  }

  if (type === 'session_info' || type === 'title') {
    return [{
      id: idBase,
      role: 'system',
      kind: 'summary',
      title: type === 'title' ? 'Session title' : 'Session info',
      rawType: type,
      isSidechain: false,
      isCompactSummary: false,
      t: timestamp,
      text: type === 'title'
        ? stringField(json, 'title')
        : stringField(json, 'name') ?? textFromUnknown(recordField(json, 'sessionInfo') ?? json),
      images: imagesFromUnknown(recordField(json, 'sessionInfo') ?? json),
    }];
  }

  if (type === 'message') {
    const message = recordField(json, 'message');
    if (!message) {
      return [{
        id: idBase,
        role: 'event',
        kind: 'event',
        title: 'Message',
        rawType: type,
        isSidechain: false,
        isCompactSummary: false,
        t: timestamp,
        text: textFromUnknown(json),
        images: imagesFromUnknown(json),
      }];
    }
    const model = stringField(message, 'responseModel') ?? stringField(message, 'model');
    return messageEntries({
      idBase,
      rawType: type,
      role: roleFromString(stringField(message, 'role')),
      content: message.content,
      timestamp: parseTimestampMs(json.timestamp, message.timestamp),
      model,
      isSidechain: false,
      isCompactSummary: false,
      tokens: piTokens(message),
    });
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
    text: textFromUnknown(json),
    images: imagesFromUnknown(json),
  }];
}

export function createPiJsonlProvider(config: PiJsonlProviderConfig) {
  return {
    id: config.id,
    label: config.label,
    defaultDataDir: config.defaultDataDir,
    defaultCachePath: config.defaultCachePath,
    detect: (dir = config.defaultDataDir()) => existsSync(dir),
    scan: (options?: ProviderScanOptions) => scanPiJsonl(config, options),
    readTranscript: (sessionId: string, options?: ProviderScanOptions) =>
      readPiJsonlTranscript(config, sessionId, options),
  } satisfies Provider;
}

const PI_CONFIG: PiJsonlProviderConfig = {
  id: 'pi',
  label: 'Pi',
  defaultDataDir,
  defaultCachePath,
};

export const piProvider = createPiJsonlProvider(PI_CONFIG);

export const _scanPi = (options?: ProviderScanOptions): Promise<ProviderScanResult> =>
  scanPiJsonl(PI_CONFIG, options);

export const _readPiTranscript = (
  sessionId: string,
  options?: ProviderScanOptions,
): Promise<SessionTranscript> => readPiJsonlTranscript(PI_CONFIG, sessionId, options);
