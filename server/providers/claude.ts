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

import { readdir, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
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

const CACHE_VERSION = 3;
const MAX_PROMPT_CHARS = 200;

type ClaudeExtra = {
  /** Session ID for this file (one session per JSONL). */
  sessionId?: string;
  /** First user prompt — fallback label when no summary exists yet. */
  firstPrompt?: string;
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
 * Project name = last segment of the encoded cwd dir, which is always the
 * first directory under `projectsDir`. Subagent JSONLs live under deeper
 * subdirs of that project dir, so we walk back to the project root.
 */
function projectNameForFile(filePath: string, projectsDir: string): string {
  const rel = filePath.startsWith(projectsDir + sep)
    ? filePath.slice(projectsDir.length + 1)
    : filePath;
  const top = rel.split(sep)[0] ?? '';
  if (!top.startsWith('-')) return top || 'unknown';
  const parts = top.slice(1).split('-');
  return parts[parts.length - 1] || top;
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
): Promise<{ entries: Entry[]; lines: number; sessionId?: string; firstPrompt?: string }> {
  let lines = 0;
  const entries: Entry[] = [];
  let sessionId: string | undefined;
  let firstPrompt: string | undefined;
  const stream = createReadStream(path, { encoding: 'utf-8', start: fromOffset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (line.length < 50) continue;

    // Cheap pre-filter: only JSON.parse lines that look like usage logs OR
    // potential first-user-prompt lines. Avoids parsing every line of the
    // ~50MB session files just to extract one prompt.
    const hasUsage = line.indexOf('"usage"') !== -1;
    const maybePrompt =
      !firstPrompt &&
      line.indexOf('"type":"user"') !== -1 &&
      line.indexOf('"isMeta":true') === -1;
    if (!hasUsage && !maybePrompt) continue;

    let json: any;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && typeof json.sessionId === 'string') sessionId = json.sessionId;

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
  return { entries, lines, sessionId, firstPrompt };
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
      const projectName = projectNameForFile(info.path, projectsDir);

      if (state.kind === 'unchanged') {
        newFiles[info.path] = state.cached;
        cachedFiles++;
        for (const e of state.cached.entries) allEntries.push(e);
        return;
      }

      if (state.kind === 'appended') {
        // The new tail can complete a streaming response whose earlier chunks
        // are already cached, so we merge then dedup-by-hash again.
        const parsed = await parseFile(info.path, projectName, state.fromOffset);
        parsedLines += parsed.lines;
        const merged = dedupByHash([...state.cached.entries, ...parsed.entries]);
        const record: FileCacheRecord<ClaudeExtra> = {
          path: info.path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          entries: merged,
          sessionId: state.cached.sessionId ?? parsed.sessionId,
          firstPrompt: state.cached.firstPrompt ?? parsed.firstPrompt,
        };
        newFiles[info.path] = record;
        for (const e of merged) allEntries.push(e);
        return;
      }

      // Cold or invalidated — parse the whole file and dedup intra-file.
      const parsed = await parseFile(info.path, projectName, 0);
      parsedLines += parsed.lines;
      const deduped = dedupByHash(parsed.entries);
      const record: FileCacheRecord<ClaudeExtra> = {
        path: info.path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        entries: deduped,
        sessionId: parsed.sessionId,
        firstPrompt: parsed.firstPrompt,
      };
      newFiles[info.path] = record;
      for (const e of deduped) allEntries.push(e);
    },
  );

  // Claude Code's `cleanupPeriodDays` (default 30) deletes session JSONLs at
  // startup. Without this carry-over the next scan would mirror that loss
  // and historical entries would silently drop out of the dashboard.
  const onDisk = new Set(files);
  for (const [path, record] of Object.entries(cache.files)) {
    if (onDisk.has(path)) continue;
    newFiles[path] = record;
    for (const e of record.entries) allEntries.push(e);
  }

  if (useCache) {
    await saveCache(cachePath, { version: CACHE_VERSION, files: newFiles });
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

export const claudeProvider: Provider = {
  id: 'cc',
  label: 'Claude Code',
  defaultDataDir,
  defaultCachePath,
  detect: (dir = defaultDataDir()) => existsSync(dir),
  scan: scanClaude,
};

// Test-only export so the existing scanner.test.ts can drive the parser
// directly without going through the Provider façade.
export { scanClaude as _scanClaude };
