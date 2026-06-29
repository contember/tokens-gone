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
  /**
   * Source of the entry. Absence is treated as `'cc'` (Claude Code) to keep
   * the field off the wire for the common case — only non-Claude entries
   * pay the extra byte. Useful for routing pricing rules and (eventually)
   * filtering in the UI.
   */
  src?: 'cc' | 'codex' | 'opencode' | 'pi';
  /** Explicit USD cost components from providers that log authoritative cost. */
  ci?: number;
  co?: number;
  cwc?: number;
  crc?: number;
};

/**
 * Per-session metadata pulled from Claude Code's own `sessions-index.json`
 * (one per project dir). The `summary` is the auto-generated title shown
 * in `/resume`; `firstPrompt` is the first user message and serves as a
 * fallback when no summary has been computed yet.
 */
export type SessionMeta = {
  summary?: string;
  firstPrompt?: string;
};

export type FileCacheRecord = {
  path: string;
  size: number;
  mtimeMs: number;
  entries: Entry[];
  /** Session ID for this file (one session per JSONL). */
  sessionId?: string;
  /** First user prompt text extracted from the file — used as a session
   * label fallback when Claude's sessions-index.json doesn't cover this
   * session. Truncated to keep transport cost down. */
  firstPrompt?: string;
};

export type CacheFile = {
  version: number;
  files: Record<string, FileCacheRecord>;
};
