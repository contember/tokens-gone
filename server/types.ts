/**
 * Compact usage entry — one Claude API response with token counts.
 * Fields are kept short and primitive to minimize transport + memory cost.
 */
export type Entry = {
  /** ISO timestamp in ms since epoch. */
  t: number;
  /** Project name (last segment of cwd). */
  p: string;
  /** Session ID. */
  s: string;
  /** Model name (e.g. claude-opus-4-7). */
  m: string;
  /** Input tokens. */
  i: number;
  /** Output tokens. */
  o: number;
  /** Cache creation input tokens. */
  cc: number;
  /** Cache read input tokens. */
  cr: number;
  /** Whether this entry was made in fast mode. */
  f: 0 | 1;
  /**
   * msgId:reqId hash for cross-file deduplication. Subagent JSONLs duplicate
   * API calls already recorded in their parent session, and Claude Code logs
   * the same response multiple times while streaming (each chunk emits a
   * separate JSONL line). All such copies share this hash; we keep the one
   * with the largest output_tokens (which is the final billed amount).
   * Stripped from the API response — internal to the server.
   */
  h?: string;
};

export type FileCacheRecord = {
  path: string;
  size: number;
  mtimeMs: number;
  entries: Entry[];
};

export type CacheFile = {
  version: number;
  files: Record<string, FileCacheRecord>;
};
