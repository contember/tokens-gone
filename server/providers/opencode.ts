/**
 * OpenCode provider.
 *
 * Reads `$XDG_DATA_HOME/opencode/opencode.db` (default
 * `~/.local/share/opencode`) — OpenCode keeps sessions in SQLite, not JSONL.
 * One `message` row per API call; assistant rows carry
 * `tokens.{input,output,cache.{read,write}}` plus a `cost` that is non-zero
 * only when OpenCode knows the model's price (API-key routing — subscription
 * providers such as GitHub Copilot log 0).
 *
 * Token mapping into our Entry shape:
 *   i  = tokens.input        // excludes cached input
 *   o  = tokens.output       // reasoning already included
 *   cc = tokens.cache.write
 *   cr = tokens.cache.read
 *
 * A logged cost > 0 wins over the built-in price list; it arrives as a single
 * total, so `addCostFields` splits it across the four components the way our
 * own pricing would. Cost 0 means "OpenCode doesn't price this model" and
 * falls back to the price list, same as Claude Code and Codex.
 *
 * The disk cache is keyed by session id instead of file path — there is only
 * one file — and a session is re-read when its message count or newest
 * timestamp moves. `stats.files` therefore counts sessions.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Entry,
  SessionMeta,
  SessionTranscript,
  TranscriptEntry,
} from '../types.ts';
import type {
  Provider,
  ProviderScanOptions,
  ProviderScanResult,
  FileCacheRecord,
} from './types.ts';
import { emptyResult } from './types.ts';
import { loadCache, saveCache } from './base.ts';
import { getPricing } from '../pricing.ts';
import {
  isRecord,
  messageEntries,
  numberField,
  openCodeTokens,
  parseTimestampMs,
  recordField,
  roleFromString,
  streamLabel,
  stringField,
} from './transcript.ts';

const CACHE_VERSION = 1;
const DB_FILE = 'opencode.db';
const MAX_PROMPT_CHARS = 200;

type OpenCodeExtra = {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  parentSessionId?: string;
  agentRole?: string;
};

type SessionRow = {
  id: string;
  parentId?: string;
  directory: string;
  title?: string;
  timeUpdated: number;
};

type MessageStat = { messages: number; updated: number };

const SESSIONS_SQL =
  'select id, parent_id, directory, title, time_updated from session';

const MESSAGE_STATS_SQL =
  'select session_id, count(*) as messages, max(time_updated) as updated from message group by session_id';

const SESSION_MESSAGES_SQL =
  'select id, time_created, data from message where session_id = ? order by time_created, id';

const SESSION_PARTS_SQL =
  'select message_id, data from part where session_id = ? order by time_created, id';

const FIRST_PROMPT_SQL = `select json_extract(p.data, '$.text') as text
  from message m join part p on p.message_id = m.id
  where m.session_id = ?
    and json_extract(m.data, '$.role') = 'user'
    and json_extract(p.data, '$.type') = 'text'
  order by m.time_created, p.id
  limit 1`;

type SqlRow = Record<string, unknown>;
type SqlStatement = { all(...params: (string | number)[]): SqlRow[] };
type SqlDatabase = { prepare(sql: string): SqlStatement; close(): void };
type SqlOpener = (path: string) => SqlDatabase;

/** Resolved once per process; `null` means this runtime has no binding. */
let opener: SqlOpener | null | undefined;

/**
 * `bun:sqlite` in dev and tests, `node:sqlite` in the published CLI (Node
 * 22.5+). Neither is a dependency, so an older Node just skips OpenCode
 * instead of failing the whole scan.
 */
async function sqliteOpener(): Promise<SqlOpener | null> {
  if (opener !== undefined) return opener;
  opener = 'Bun' in globalThis ? await bunOpener() : await nodeOpener();
  if (!opener) {
    console.warn(
      'tokens-gone: found OpenCode data but this runtime has no SQLite binding (needs Node 22.5+) — skipping OpenCode.',
    );
  }
  return opener;
}

async function bunOpener(): Promise<SqlOpener | null> {
  try {
    const { Database } = await import('bun:sqlite');
    return (path) => {
      const db = new Database(path, { readonly: true });
      return {
        prepare: (sql) => db.query<SqlRow, (string | number)[]>(sql),
        close: () => db.close(),
      };
    };
  } catch {
    return null;
  }
}

async function nodeOpener(): Promise<SqlOpener | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return (path) => {
      const db = new DatabaseSync(path, { readOnly: true });
      return {
        prepare: (sql) => db.prepare(sql),
        close: () => db.close(),
      };
    };
  } catch {
    return null;
  }
}

function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
}

function defaultCachePath(): string {
  return join(homedir(), '.cache', 'tokens-gone', 'opencode-cache.json');
}

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

function usageKey(messageId: string): string {
  return `opencode:${messageId}`;
}

function parseJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, MAX_PROMPT_CHARS) : undefined;
}

function sessionFromRow(row: SqlRow): SessionRow | undefined {
  const id = stringField(row, 'id');
  if (!id) return undefined;
  return {
    id,
    parentId: stringField(row, 'parent_id'),
    directory: stringField(row, 'directory') ?? '',
    title: trimmed(stringField(row, 'title')),
    timeUpdated: numberField(row, 'time_updated') ?? 0,
  };
}

function messageStats(db: SqlDatabase): Map<string, MessageStat> {
  const stats = new Map<string, MessageStat>();
  for (const row of db.prepare(MESSAGE_STATS_SQL).all()) {
    const id = stringField(row, 'session_id');
    if (!id) continue;
    stats.set(id, {
      messages: numberField(row, 'messages') ?? 0,
      updated: numberField(row, 'updated') ?? 0,
    });
  }
  return stats;
}

/** Spread a single logged total over the components our price list would bill. */
function addCostFields(entry: Entry, cost: number): void {
  const p = getPricing(entry.m);
  const wInput = p ? entry.i * p.input : 0;
  const wOutput = p ? entry.o * p.output : 0;
  const wCacheWrite = p ? entry.cc * p.cacheWrite : 0;
  const wCacheRead = p ? entry.cr * p.cacheRead : 0;
  const total = wInput + wOutput + wCacheWrite + wCacheRead;
  if (total <= 0) {
    entry.ci = cost;
    return;
  }
  entry.ci = (cost * wInput) / total;
  entry.co = (cost * wOutput) / total;
  entry.cwc = (cost * wCacheWrite) / total;
  entry.crc = (cost * wCacheRead) / total;
}

function entryFromMessage(
  row: SqlRow,
  data: Record<string, unknown>,
  session: SessionRow,
): Entry | undefined {
  const tokens = recordField(data, 'tokens');
  if (!tokens) return undefined;
  const cache = recordField(tokens, 'cache');
  const input = numberField(tokens, 'input') ?? 0;
  const output = numberField(tokens, 'output') ?? 0;
  const cacheWrite = cache ? numberField(cache, 'write') ?? 0 : 0;
  const cacheRead = cache ? numberField(cache, 'read') ?? 0 : 0;
  const cost = numberField(data, 'cost') ?? 0;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0 && cost === 0) {
    return undefined;
  }

  const time = recordField(data, 'time');
  const t = parseTimestampMs(time?.completed, time?.created, row.time_created);
  if (t === undefined) return undefined;

  const path = recordField(data, 'path');
  const cwd = (path ? stringField(path, 'cwd') : undefined) ?? session.directory;
  const entry: Entry = {
    t,
    p: projectNameFromCwd(cwd),
    s: session.id,
    m: stringField(data, 'modelID') ?? 'unknown',
    i: input,
    o: output,
    cc: cacheWrite,
    cr: cacheRead,
    f: 0,
    src: 'opencode',
  };
  const messageId = stringField(row, 'id');
  if (messageId) entry.h = usageKey(messageId);
  if (cost > 0) addCostFields(entry, cost);
  return entry;
}

function parseSession(
  session: SessionRow,
  rows: SqlRow[],
): { entries: Entry[]; agentRole?: string } {
  const entries: Entry[] = [];
  let agentRole: string | undefined;
  for (const row of rows) {
    const data = parseJson(stringField(row, 'data'));
    if (!data || stringField(data, 'role') !== 'assistant') continue;
    agentRole ??= stringField(data, 'agent');
    const entry = entryFromMessage(row, data, session);
    if (entry) entries.push(entry);
  }
  return { entries, agentRole };
}

function firstPrompt(statement: SqlStatement, sessionId: string): string | undefined {
  const row = statement.all(sessionId)[0];
  return row ? trimmed(stringField(row, 'text')) : undefined;
}

function addSessionMeta(
  target: Record<string, SessionMeta>,
  record: FileCacheRecord<OpenCodeExtra>,
): void {
  const meta: SessionMeta = {};
  if (record.summary) meta.summary = record.summary;
  if (record.firstPrompt) meta.firstPrompt = record.firstPrompt;
  if (record.parentSessionId) {
    meta.parentSessionId = record.parentSessionId;
    meta.threadSource = 'subagent';
  }
  if (record.agentRole) meta.agentRole = record.agentRole;
  if (Object.keys(meta).length > 0) target[record.sessionId] = meta;
}

async function scanOpenCode(options: ProviderScanOptions = {}): Promise<ProviderScanResult> {
  const t0 = performance.now();
  const dataDir = options.dataDir ?? defaultDataDir();
  const cachePath = options.cachePath ?? defaultCachePath();
  const useCache = options.useCache !== false;
  const dbPath = join(dataDir, DB_FILE);
  if (!existsSync(dbPath)) return emptyResult();

  const open = await sqliteOpener();
  if (!open) return emptyResult();

  const cache = useCache
    ? await loadCache<OpenCodeExtra>(cachePath, CACHE_VERSION)
    : { version: CACHE_VERSION, files: {} as Record<string, FileCacheRecord<OpenCodeExtra>> };

  let db: SqlDatabase;
  try {
    db = open(dbPath);
  } catch {
    return emptyResult();
  }

  const entries: Entry[] = [];
  const sessionMeta: Record<string, SessionMeta> = {};
  const files: Record<string, FileCacheRecord<OpenCodeExtra>> = {};
  let cachedFiles = 0;
  let parsedMessages = 0;

  try {
    const stats = messageStats(db);
    const messages = db.prepare(SESSION_MESSAGES_SQL);
    const prompts = db.prepare(FIRST_PROMPT_SQL);

    for (const row of db.prepare(SESSIONS_SQL).all()) {
      const session = sessionFromRow(row);
      if (!session) continue;
      const stat = stats.get(session.id);
      const count = stat?.messages ?? 0;
      const updated = Math.max(session.timeUpdated, stat?.updated ?? 0);

      const cached = cache.files[session.id];
      if (cached && cached.path === dbPath && cached.size === count && cached.mtimeMs === updated) {
        files[session.id] = cached;
        cachedFiles++;
        for (const e of cached.entries) entries.push(e);
        addSessionMeta(sessionMeta, cached);
        continue;
      }

      const parsed = parseSession(session, messages.all(session.id));
      parsedMessages += count;
      const record: FileCacheRecord<OpenCodeExtra> = {
        path: dbPath,
        size: count,
        mtimeMs: updated,
        entries: parsed.entries,
        sessionId: session.id,
        summary: session.title,
        firstPrompt: firstPrompt(prompts, session.id),
        parentSessionId: session.parentId,
        agentRole: parsed.agentRole,
      };
      files[session.id] = record;
      for (const e of parsed.entries) entries.push(e);
      addSessionMeta(sessionMeta, record);
    }
  } finally {
    db.close();
  }

  const sessionCount = Object.keys(files).length;
  if (useCache && (parsedMessages > 0 || sessionCount !== Object.keys(cache.files).length)) {
    void saveCache(cachePath, { version: CACHE_VERSION, files });
  }

  entries.sort((a, b) => a.t - b.t);

  return {
    entries,
    sessionMeta,
    stats: {
      files: sessionCount,
      cachedFiles,
      parsedLines: parsedMessages,
      tookMs: Math.round(performance.now() - t0),
    },
  };
}

/**
 * Reshape one OpenCode part into the Claude-style content blocks the shared
 * transcript renderer understands. Step bookkeeping is dropped — the usage it
 * carries is already on the message.
 */
function blocksFromPart(part: Record<string, unknown>): unknown[] {
  const type = stringField(part, 'type');
  if (type === 'step-start' || type === 'step-finish') return [];

  if (type === 'text') {
    return [{ type: 'text', text: stringField(part, 'text') ?? '' }];
  }

  if (type === 'reasoning') {
    const text = stringField(part, 'text');
    return text ? [{ type: 'thinking', thinking: text }] : [];
  }

  if (type === 'tool') {
    const state = recordField(part, 'state');
    const blocks: unknown[] = [
      { type: 'tool_use', name: stringField(part, 'tool') ?? 'tool', input: state?.input },
    ];
    const output = state?.output ?? state?.error;
    if (output !== undefined) {
      blocks.push({ type: 'tool_result', tool_use_id: stringField(part, 'callID'), content: output });
    }
    return blocks;
  }

  if (type === 'file') {
    const mime = stringField(part, 'mime') ?? '';
    const url = stringField(part, 'url');
    if (url && mime.startsWith('image/')) {
      return [{ type: 'image', source: { media_type: mime, data: url } }];
    }
  }

  return [part];
}

function transcriptEntries(
  messageId: string,
  row: SqlRow,
  data: Record<string, unknown>,
  parts: Record<string, unknown>[],
): TranscriptEntry[] {
  const rawRole = stringField(data, 'role');
  const role = roleFromString(rawRole);
  const time = recordField(data, 'time');
  const blocks: unknown[] = [];
  let isCompactSummary = false;
  for (const part of parts) {
    if (stringField(part, 'type') === 'compaction') isCompactSummary = true;
    blocks.push(...blocksFromPart(part));
  }

  return messageEntries({
    idBase: messageId,
    rawType: `message:${rawRole ?? 'unknown'}`,
    role,
    content: blocks,
    timestamp: parseTimestampMs(time?.created, row.time_created),
    model: stringField(data, 'modelID'),
    usageKey: role === 'assistant' ? usageKey(messageId) : undefined,
    isSidechain: false,
    isCompactSummary,
    tokens: role === 'assistant' ? openCodeTokens(data) : undefined,
  });
}

async function readOpenCodeTranscript(
  sessionId: string,
  options: ProviderScanOptions = {},
): Promise<SessionTranscript> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const dbPath = join(dataDir, DB_FILE);
  const empty = emptyTranscript(sessionId);
  if (!existsSync(dbPath)) return empty;

  const open = await sqliteOpener();
  if (!open) return empty;

  let db: SqlDatabase;
  try {
    db = open(dbPath);
  } catch {
    return empty;
  }

  const entries: TranscriptEntry[] = [];
  try {
    const partsByMessage = new Map<string, Record<string, unknown>[]>();
    for (const row of db.prepare(SESSION_PARTS_SQL).all(sessionId)) {
      const messageId = stringField(row, 'message_id');
      const data = parseJson(stringField(row, 'data'));
      if (!messageId || !data) continue;
      const bucket = partsByMessage.get(messageId);
      if (bucket) bucket.push(data);
      else partsByMessage.set(messageId, [data]);
    }

    for (const row of db.prepare(SESSION_MESSAGES_SQL).all(sessionId)) {
      const messageId = stringField(row, 'id');
      const data = parseJson(stringField(row, 'data'));
      if (!messageId || !data) continue;
      entries.push(...transcriptEntries(messageId, row, data, partsByMessage.get(messageId) ?? []));
    }
  } finally {
    db.close();
  }

  if (entries.length === 0) return empty;

  return {
    sessionId,
    provider: 'opencode',
    streams: [{
      id: sessionId,
      label: streamLabel(DB_FILE, 'main'),
      path: DB_FILE,
      kind: 'main',
      isSidechain: false,
      entries,
    }],
    sourceFiles: 1,
    totalEntries: entries.length,
    missingRaw: false,
  };
}

function emptyTranscript(sessionId: string): SessionTranscript {
  return {
    sessionId,
    provider: 'opencode',
    streams: [],
    sourceFiles: 0,
    totalEntries: 0,
    missingRaw: true,
  };
}

export const openCodeProvider: Provider = {
  id: 'opencode',
  label: 'OpenCode',
  defaultDataDir,
  defaultCachePath,
  detect: (dir = defaultDataDir()) => existsSync(join(dir, DB_FILE)),
  scan: scanOpenCode,
  readTranscript: readOpenCodeTranscript,
};

export { readOpenCodeTranscript as _readOpenCodeTranscript, scanOpenCode as _scanOpenCode };
