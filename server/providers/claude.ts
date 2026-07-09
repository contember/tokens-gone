/**
 * Claude Code provider.
 *
 * Reads `~/.claude/projects/**\/*.jsonl`. Each `.jsonl` is a session log
 * with one JSON object per line. Assistant messages carry `usage.{input_tokens,
 * output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` which
 * maps 1:1 onto our `Entry` shape.
 *
 * Deduplication is two layers deep:
 *   1. Intra-file: streaming responses log one line per chunk, each with the
 *      same msgId:reqId. We keep the chunk with the largest output_tokens
 *      (the final billed amount).
 *   2. Cross-file: subagent JSONLs replicate their parent session's API
 *      calls. Same msgId:reqId across files → also collapsed.
 * Entries without a msgId:reqId fall back to structural dedup by
 * `t|s|i|o|cc|cr`.
 *
 * Session titles ("summary") come from Claude's `sessions-index.json`, one
 * per project dir. When that's missing we fall back to the first user
 * message extracted from the JSONL itself.
 */

import { readdir, stat, readFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, sep } from 'node:path';
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
  attachmentEntry,
  booleanField,
  claudeTokens,
  countEntries,
  imagesFromUnknown,
  isCompactLike,
  messageEntries,
  metaFromRoot,
  parseTimestampMs,
  providerPath,
  readJsonlObjects,
  recordField,
  roleFromString,
  sortStreams,
  streamKindFromPath,
  streamLabel,
  stringField,
  textFromUnknown,
} from './transcript.ts';

const CACHE_VERSION = 3;
const MAX_PROMPT_CHARS = 200;

type ClaudeExtra = {
  /** Session ID for this file (one session per JSONL). */
  sessionId?: string;
  /** First user prompt — fallback label when no summary exists yet. */
  firstPrompt?: string;
  /**
   * Real cwd extracted from the JSONL itself. The encoded project dir name
   * (`-Users-foo-bar-tokens-gone`) is lossy — Claude Code replaces both `/`
   * and `-` with `-`, so you can't tell `tokens-gone` from `tokens/gone`
   * apart from the dir alone. Storing the cwd lets us name projects
   * correctly without re-parsing.
   */
  cwd?: string;
};

function defaultDataDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(homedir(), '.claude', 'projects');
}

function defaultCachePath(): string {
  return join(homedir(), '.cache', 'tokens-gone', 'cache.json');
}

/**
 * Encoded project dir = first directory under `projectsDir`. Subagent JSONLs
 * live under deeper subdirs of that project dir, so we walk back to the
 * project root.
 */
function projectDirForFile(filePath: string, projectsDir: string): string {
  const rel = filePath.startsWith(projectsDir + sep)
    ? filePath.slice(projectsDir.length + 1)
    : filePath;
  return rel.split(sep)[0] ?? '';
}

/**
 * Fallback project name when no `cwd` is available in the JSONL. Claude
 * Code encodes the cwd by replacing both `/` and `-` with `-`, so the
 * encoded dir is lossy — taking the last segment is a guess that loses
 * everything before the final `-` (e.g. `tokens-gone` → `gone`). Only use
 * this when nothing in the file has surfaced a real cwd yet.
 */
function fallbackProjectName(encodedDir: string): string {
  if (!encodedDir.startsWith('-')) return encodedDir || 'unknown';
  const parts = encodedDir.slice(1).split('-');
  return parts[parts.length - 1] || encodedDir;
}

/**
 * Load per-session summaries from Claude Code's own `sessions-index.json`
 * files (one per project dir). Missing or malformed files are skipped —
 * the index is only written by `/resume` and similar flows, so it's normal
 * for many project dirs not to have one.
 */
async function loadSessionMeta(projectsDir: string): Promise<Record<string, SessionMeta>> {
  const out: Record<string, SessionMeta> = {};
  let topLevel: { name: string; isDirectory: boolean }[];
  try {
    const raw = await readdir(projectsDir, { withFileTypes: true });
    topLevel = raw.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch {
    return out;
  }
  const dirs = topLevel.filter((d) => d.isDirectory).map((d) => join(projectsDir, d.name));
  await Promise.all(
    dirs.map(async (dir) => {
      const indexPath = join(dir, 'sessions-index.json');
      try {
        const raw = await readFile(indexPath, 'utf-8').catch(() => null);
        if (raw == null) return;
        const data = JSON.parse(raw) as {
          entries?: Array<{ sessionId?: string; summary?: string; firstPrompt?: string }>;
        };
        if (!data?.entries) return;
        for (const e of data.entries) {
          if (!e.sessionId) continue;
          out[e.sessionId] = {
            summary: e.summary || undefined,
            firstPrompt: e.firstPrompt || undefined,
          };
        }
      } catch {
        // Malformed index — skip silently.
      }
    }),
  );
  return out;
}

/**
 * Cheap one-shot cwd read. Used to backfill cwd into cached records whose
 * file isn't being re-parsed this scan — without it, caches written before
 * the cwd field existed would never get a real project name. We stop as
 * soon as we see one cwd, which is usually within the first few lines.
 */
/**
 * Read just enough of the head of the file to find a cwd record. Session
 * logs start with system/user/assistant records that all carry cwd, so
 * the first one is essentially always within the first few KB. 64KB is
 * conservative and saves us from streaming 50MB files just to peek one
 * field. Plain fd reads (no stream pipeline) keep async error semantics
 * trivially correct under bun's strict unhandled-error detection.
 */
const PEEK_BYTES = 64 * 1024;

async function peekCwd(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return undefined;
    const text = buf.toString('utf-8', 0, bytesRead);
    // Drop the trailing partial line so JSON.parse doesn't choke on it.
    const lastNl = text.lastIndexOf('\n');
    const usable = lastNl === -1 ? text : text.slice(0, lastNl);
    for (const line of usable.split('\n')) {
      if (line.indexOf('"cwd"') === -1) continue;
      try {
        const json = JSON.parse(line);
        if (typeof json.cwd === 'string' && json.cwd) return json.cwd;
      } catch {
        // Malformed line — keep looking.
      }
    }
  } catch {
    // File may have been deleted between scans (Claude Code's cleanup
    // sweep), unreadable, or otherwise broken — skip and let the caller
    // try the next file in the dir.
  } finally {
    await fh?.close().catch(() => undefined);
  }
  return undefined;
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
): Promise<{
  entries: Entry[];
  lines: number;
  sessionId?: string;
  firstPrompt?: string;
  cwd?: string;
}> {
  let lines = 0;
  const entries: Entry[] = [];
  let sessionId: string | undefined;
  let firstPrompt: string | undefined;
  let cwd: string | undefined;
  const stream = createReadStream(path, { encoding: 'utf-8', start: fromOffset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (line.length < 50) continue;

    // Cheap pre-filter: only JSON.parse lines that look like usage logs OR
    // potential first-user-prompt lines OR the first line carrying cwd.
    // Avoids parsing every line of the ~50MB session files just to extract
    // one prompt.
    const hasUsage = line.indexOf('"usage"') !== -1;
    const maybePrompt =
      !firstPrompt &&
      line.indexOf('"type":"user"') !== -1 &&
      line.indexOf('"isMeta":true') === -1;
    const maybeCwd = !cwd && line.indexOf('"cwd"') !== -1;
    if (!hasUsage && !maybePrompt && !maybeCwd) continue;

    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && typeof json.sessionId === 'string') sessionId = json.sessionId;
    if (!cwd && typeof json.cwd === 'string' && json.cwd) cwd = json.cwd;

    if (!firstPrompt && json.type === 'user' && !json.isMeta && !json.isSidechain) {
      const text = extractUserText(json?.message?.content);
      if (text) firstPrompt = text.slice(0, MAX_PROMPT_CHARS);
    }

    if (!hasUsage) continue;

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
      // src omitted → defaults to 'cc' downstream. Keeps the cache (and the
      // JSON payload) smaller for the common case.
    });
  }
  return { entries, lines, sessionId, firstPrompt, cwd };
}

/**
 * Pull a user-typed string out of a Claude Code user message. Skips
 * tool_result entries, tool-use blocks, and slash-command wrappers
 * (Claude Code logs e.g. `/clear` as `<command-name>/clear</command-name>…`
 * — useful as a marker, useless as a session label).
 */
function extractUserText(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') {
        text = b.text;
        break;
      }
    }
  }
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<command-message>') ||
    trimmed.startsWith('<local-command-')
  ) {
    return undefined;
  }
  return trimmed;
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

/**
 * Strip out cached firstPrompt values that are actually slash-command
 * wrappers. We keep these in the on-disk cache to avoid forcing a re-parse
 * on every parser rule tweak, but filter them at the assembly boundary.
 */
function sanitizePrompt(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t) return undefined;
  if (
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<local-command-')
  ) {
    return undefined;
  }
  return t;
}

async function scanClaude(options: ProviderScanOptions = {}): Promise<ProviderScanResult> {
  const t0 = performance.now();
  const projectsDir = options.dataDir ?? defaultDataDir();
  const cachePath = options.cachePath ?? defaultCachePath();
  const useCache = options.useCache !== false;
  const concurrency = options.concurrency ?? 16;

  if (!existsSync(projectsDir)) return emptyResult();

  const [files, sessionMeta] = await Promise.all([
    listJsonlFiles(projectsDir),
    loadSessionMeta(projectsDir),
  ]);
  const cache = useCache
    ? await loadCache<ClaudeExtra>(cachePath, CACHE_VERSION)
    : { version: CACHE_VERSION, files: {} as Record<string, FileCacheRecord<ClaudeExtra>> };

  let cachedFiles = 0;
  let parsedLines = 0;
  const allEntries: Entry[] = [];
  const newFiles: Record<string, FileCacheRecord<ClaudeExtra>> = {};

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
      const state = decideFileState<ClaudeExtra>(info, cache.files[info.path]);

      if (state.kind === 'unchanged') {
        newFiles[info.path] = state.cached;
        cachedFiles++;
        return;
      }

      // parseFile pre-stamps every entry's `p` with this value; we overwrite
      // it below once cwd is known, so any string works here.
      const placeholderName = '';

      if (state.kind === 'appended') {
        // The new tail can complete a streaming response whose earlier chunks
        // are already cached, so we merge then dedup-by-hash again.
        const parsed = await parseFile(info.path, placeholderName, state.fromOffset);
        parsedLines += parsed.lines;
        const merged = dedupByHash([...state.cached.entries, ...parsed.entries]);
        const record: FileCacheRecord<ClaudeExtra> = {
          path: info.path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          entries: merged,
          sessionId: state.cached.sessionId ?? parsed.sessionId,
          firstPrompt: state.cached.firstPrompt ?? parsed.firstPrompt,
          cwd: state.cached.cwd ?? parsed.cwd,
        };
        newFiles[info.path] = record;
        return;
      }

      // Cold or invalidated — parse the whole file and dedup intra-file.
      const parsed = await parseFile(info.path, placeholderName, 0);
      parsedLines += parsed.lines;
      const deduped = dedupByHash(parsed.entries);
      const record: FileCacheRecord<ClaudeExtra> = {
        path: info.path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        entries: deduped,
        sessionId: parsed.sessionId,
        firstPrompt: parsed.firstPrompt,
        cwd: parsed.cwd,
      };
      newFiles[info.path] = record;
    },
  );

  // Claude Code's `cleanupPeriodDays` (default 30) deletes session JSONLs at
  // startup. Without this carry-over the next scan would mirror that loss
  // and historical entries would silently drop out of the dashboard.
  const onDisk = new Set(files);
  let preservedDeleted = 0;
  for (const [path, record] of Object.entries(cache.files)) {
    if (onDisk.has(path)) continue;
    newFiles[path] = record;
    preservedDeleted++;
  }

  // Resolve the real project name per encoded dir by pooling cwds across all
  // sibling files. One file with a cwd record is enough to name the whole
  // dir, so files that never wrote a cwd line (or pre-fix cached records)
  // still get the right label. Falls back to the lossy `-` heuristic only
  // when no file in the dir has surfaced a cwd.
  const dirCwds = new Map<string, string>();
  const dirFiles = new Map<string, string[]>();
  for (const [path, rec] of Object.entries(newFiles)) {
    const dir = projectDirForFile(path, projectsDir);
    let bucket = dirFiles.get(dir);
    if (!bucket) {
      bucket = [];
      dirFiles.set(dir, bucket);
    }
    bucket.push(path);
    if (rec.cwd && !dirCwds.has(dir)) dirCwds.set(dir, rec.cwd);
  }

  // Backfill cwd for dirs whose records were all written before the cwd
  // field existed in the cache. One peek per unresolved dir (not per file)
  // — cheap, and persisting cwd onto the records means it's a one-shot cost.
  let backfilledDirs = 0;
  const unresolvedDirs: string[] = [];
  for (const dir of dirFiles.keys()) {
    if (!dirCwds.has(dir)) unresolvedDirs.push(dir);
  }
  await pMap(unresolvedDirs, concurrency, async (dir) => {
    const paths = dirFiles.get(dir) ?? [];
    for (const file of paths) {
      const cwd = await peekCwd(file);
      if (!cwd) continue;
      dirCwds.set(dir, cwd);
      const rec = newFiles[file];
      if (rec) rec.cwd = cwd;
      backfilledDirs++;
      return;
    }
  });

  const dirNames = new Map<string, string>();
  function projectNameFor(path: string): string {
    const dir = projectDirForFile(path, projectsDir);
    let name = dirNames.get(dir);
    if (name !== undefined) return name;
    const cwd = dirCwds.get(dir);
    name = cwd ? basename(cwd) : fallbackProjectName(dir);
    dirNames.set(dir, name);
    return name;
  }

  // Now collect entries with the resolved project name. Re-stamp `.p` on
  // every entry — cached records may carry the old (truncated) value from
  // before this fix, and freshly parsed entries got a placeholder.
  for (const [path, record] of Object.entries(newFiles)) {
    const projectName = projectNameFor(path);
    for (const e of record.entries) {
      e.p = projectName;
      allEntries.push(e);
    }
  }

  if (useCache) {
    // When nothing was parsed and the file set is unchanged, the in-memory
    // cache mirrors what's on disk already — skip the (very expensive)
    // 30MB+ JSON.stringify + write. When there *is* a change, kick the
    // write off in the background so the API response doesn't block on
    // disk I/O; `saveCache` updates the in-memory copy synchronously.
    const fileSetChanged = files.length + preservedDeleted !== Object.keys(cache.files).length;
    if (parsedLines > 0 || fileSetChanged || backfilledDirs > 0) {
      void saveCache(cachePath, { version: CACHE_VERSION, files: newFiles });
    }
  }

  // Backfill firstPrompt for any session that wasn't found in Claude's
  // sessions-index.json. The index covers only a fraction of sessions
  // (resumed/explicitly-tracked), so without this fallback most rows
  // would show as "(untitled)".
  for (const record of Object.values(newFiles)) {
    if (!record.sessionId) continue;
    const prompt = sanitizePrompt(record.firstPrompt);
    if (!prompt) continue;
    const existing = sessionMeta[record.sessionId];
    if (!existing) {
      sessionMeta[record.sessionId] = { firstPrompt: prompt };
    } else if (!existing.firstPrompt) {
      existing.firstPrompt = prompt;
    }
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
    sessionMeta,
    stats: {
      files: files.length,
      cachedFiles,
      parsedLines,
      tookMs: Math.round(performance.now() - t0),
    },
  };
}

async function readClaudeTranscript(
  sessionId: string,
  options: ProviderScanOptions = {},
): Promise<SessionTranscript> {
  const defaultDir = defaultDataDir();
  const projectsDir = options.dataDir ?? defaultDir;
  const cachePath = options.cachePath ?? defaultCachePath();
  const concurrency = options.concurrency ?? 16;
  const useCacheIndex =
    options.useCache !== false && (options.cachePath !== undefined || projectsDir === defaultDir);
  if (!existsSync(projectsDir)) return emptyClaudeTranscript(sessionId);

  const files = await transcriptFiles(projectsDir, cachePath, sessionId, useCacheIndex);
  const streams: SessionTranscript['streams'] = [];

  await pMap(files, concurrency, async (path) => {
    const entries: TranscriptEntry[] = [];
    try {
      await readJsonlObjects(path, (json, lineNo) => {
        const lineSessionId = stringField(json, 'sessionId') ?? stringField(json, 'session_id');
        if (lineSessionId !== sessionId) return;
        entries.push(...claudeLineEntries(json, path, lineNo, streamKindFromPath(path) === 'subagent'));
      });
    } catch {
      return;
    }
    if (entries.length === 0) return;

    const rel = providerPath(projectsDir, path);
    const allSidechain = entries.length > 0 && entries.every((entry) => entry.isSidechain);
    const kind = streamKindFromPath(path) === 'subagent' || allSidechain ? 'subagent' : 'main';
    streams.push({
      id: rel,
      label: streamLabel(rel, kind),
      path: rel,
      kind,
      isSidechain: kind === 'subagent' || allSidechain,
      entries,
    });
  });

  sortStreams(streams);
  return {
    sessionId,
    provider: 'cc',
    streams,
    sourceFiles: streams.length,
    totalEntries: countEntries(streams),
    missingRaw: streams.length === 0,
  };
}

async function transcriptFiles(
  projectsDir: string,
  cachePath: string,
  sessionId: string,
  useCache: boolean,
): Promise<string[]> {
  if (useCache) {
    const cache = await loadCache<ClaudeExtra>(cachePath, CACHE_VERSION);
    const cachedMatches = Object.values(cache.files).filter((record) => record.sessionId === sessionId);
    if (cachedMatches.length > 0) {
      const paths = new Set<string>();
      for (const record of cachedMatches) {
        if (existsSync(record.path)) paths.add(record.path);
      }
      return [...paths];
    }
  }
  return listJsonlFiles(projectsDir);
}

function emptyClaudeTranscript(sessionId: string): SessionTranscript {
  return {
    sessionId,
    provider: 'cc',
    streams: [],
    sourceFiles: 0,
    totalEntries: 0,
    missingRaw: true,
  };
}

function claudeLineEntries(
  json: Record<string, unknown>,
  path: string,
  lineNo: number,
  pathIsSubagent: boolean,
): TranscriptEntry[] {
  const type = stringField(json, 'type') ?? 'event';
  const subtype = stringField(json, 'subtype');
  const rawType = subtype ? `${type}:${subtype}` : type;
  const timestamp = parseTimestampMs(json.timestamp);
  const isSidechain = booleanField(json, 'isSidechain') ?? pathIsSubagent;
  const compact = isCompactLike(json);
  const meta = metaFromRoot(json);
  const idBase = `${path}:${lineNo}`;
  const message = recordField(json, 'message');

  if (message) {
    const usage = recordField(message, 'usage');
    const messageId = stringField(message, 'id');
    const requestId = stringField(json, 'requestId');
    return messageEntries({
      idBase,
      rawType,
      role: roleFromString(stringField(message, 'role') ?? type),
      content: message.content,
      timestamp: parseTimestampMs(json.timestamp, message.timestamp),
      model: stringField(message, 'model'),
      usageKey: messageId && requestId ? `${messageId}:${requestId}` : undefined,
      fast: usage && stringField(usage, 'speed') === 'fast' ? 1 : 0,
      isSidechain,
      isCompactSummary: compact,
      tokens: claudeTokens(message),
      meta,
    });
  }

  if (type === 'system') {
    const duration = numberFieldOrText(json, 'durationMs');
    return [{
      id: idBase,
      role: 'system',
      kind: compact ? 'summary' : 'event',
      title: compact ? 'Context compaction' : subtype ? `System · ${subtype}` : 'System',
      rawType,
      isSidechain,
      isCompactSummary: compact,
      t: timestamp,
      text: textFromUnknown(json.content) ?? duration,
      images: imagesFromUnknown(json.content),
      meta,
    }];
  }

  if (type === 'attachment') {
    return [attachmentEntry({
      id: idBase,
      rawType,
      attachment: json.attachment,
      timestamp,
      isSidechain,
      isCompactSummary: compact,
      meta,
    })];
  }

  if (type === 'progress') {
    return [{
      id: idBase,
      role: 'event',
      kind: 'progress',
      title: 'Progress',
      rawType,
      isSidechain,
      isCompactSummary: compact,
      t: timestamp,
      text: textFromUnknown(json.data),
      images: imagesFromUnknown(json.data),
      meta,
    }];
  }

  return [{
    id: idBase,
    role: compact ? 'system' : 'event',
    kind: compact ? 'summary' : 'event',
    title: compact ? 'Context compaction' : eventTitle(type),
    rawType,
    isSidechain,
    isCompactSummary: compact,
    t: timestamp,
    text: eventText(json, type),
    images: imagesFromUnknown(json),
    meta,
  }];
}

function eventTitle(type: string): string {
  if (type === 'last-prompt') return 'Last prompt marker';
  if (type === 'ai-title') return 'AI title';
  if (type === 'mode') return 'Mode';
  if (type === 'permission-mode') return 'Permission mode';
  if (type === 'bridge-session') return 'Bridge session';
  return `Event · ${type}`;
}

function eventText(json: Record<string, unknown>, type: string): string | undefined {
  if (type === 'last-prompt') return textFromUnknown(json.lastPrompt ?? json.leafUuid);
  if (type === 'ai-title') return textFromUnknown(json.aiTitle);
  if (type === 'mode') return textFromUnknown(json.mode);
  if (type === 'permission-mode') return textFromUnknown(json.permissionMode);
  return textFromUnknown(json);
}

function numberFieldOrText(json: Record<string, unknown>, key: string): string | undefined {
  const value = json[key];
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : undefined;
}

export const claudeProvider: Provider = {
  id: 'cc',
  label: 'Claude Code',
  defaultDataDir,
  defaultCachePath,
  detect: (dir = defaultDataDir()) => existsSync(dir),
  scan: scanClaude,
  readTranscript: readClaudeTranscript,
};

// Test-only export so the existing scanner.test.ts can drive the parser
// directly without going through the Provider façade.
export { readClaudeTranscript as _readClaudeTranscript, scanClaude as _scanClaude };
