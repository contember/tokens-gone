/**
 * Provider contract.
 *
 * A provider is an adapter for a single AI coding harness (Claude Code,
 * Codex, OpenCode). Each provider is responsible for:
 *  - knowing where its data lives on disk
 *  - detecting whether the user actually uses that tool
 *  - parsing its raw log/db format into the shared `Entry` shape
 *  - managing its own per-file disk cache so re-scans are incremental
 *
 * The server treats providers as opaque: it asks each one to scan,
 * concatenates the resulting entries, and re-sorts. No cross-provider
 * dedup is needed because session ID spaces (UUIDs) don't collide.
 */

import type { Entry, SessionMeta } from '../types.ts';

/** Identifier baked into the `Entry.src` field. */
export type ProviderId = 'cc' | 'codex' | 'opencode';

export type ProviderScanOptions = {
  /** Override the default data directory (env-var or user-set). */
  dataDir?: string;
  /** Override the default cache file path. */
  cachePath?: string;
  /** When false, don't read or write the disk cache. */
  useCache?: boolean;
  /** Max parallel file reads. */
  concurrency?: number;
};

export type ProviderScanStats = {
  files: number;
  cachedFiles: number;
  parsedLines: number;
  tookMs: number;
};

export type ProviderScanResult = {
  entries: Entry[];
  sessionMeta: Record<string, SessionMeta>;
  stats: ProviderScanStats;
};

export interface Provider {
  /** Stable id — written into every entry's `src` field. */
  readonly id: ProviderId;
  /** Human label for logs and (eventually) UI badges. */
  readonly label: string;
  /** Default location the provider reads from (env-aware). */
  defaultDataDir(): string;
  /** Default on-disk cache path (env-aware). */
  defaultCachePath(): string;
  /** Cheap synchronous check: does the data dir exist? */
  detect(dataDir?: string): boolean;
  /** Run a full or incremental scan. Always returns — empty if nothing detected. */
  scan(opts?: ProviderScanOptions): Promise<ProviderScanResult>;
}

/**
 * Shape every per-file cache record extends. Each provider can add
 * format-specific fields via the `TExtra` type parameter (Claude tracks
 * `firstPrompt` and `sessionId`, Codex tracks the same plus could grow
 * a `lastModel` for tail-parse priming).
 */
export type FileCacheRecord<TExtra = unknown> = {
  path: string;
  size: number;
  mtimeMs: number;
  entries: Entry[];
} & TExtra;

export type CacheFile<TExtra = unknown> = {
  version: number;
  files: Record<string, FileCacheRecord<TExtra>>;
};

export function emptyResult(): ProviderScanResult {
  return {
    entries: [],
    sessionMeta: {},
    stats: { files: 0, cachedFiles: 0, parsedLines: 0, tookMs: 0 },
  };
}
