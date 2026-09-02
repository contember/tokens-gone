/** One request, as served by `/api/session-entries`. */
export type Entry = {
  t: number;
  p: string;
  s: string;
  m: string;
  i: number;
  o: number;
  cc: number;
  cr: number;
  f: 0 | 1;
  /** Explicit USD cost components from providers that log authoritative cost. */
  ci?: number;
  co?: number;
  cwc?: number;
  crc?: number;
  /** Source of the entry. Missing means Claude Code. */
  src?: 'cc' | 'codex' | 'opencode' | 'pi' | 'omp';
};

export type RankedRequest = Entry & {
  /** Authoritative per-request cost in USD, computed by the server. */
  c: number;
};

export type RequestList = {
  entries: RankedRequest[];
  total: number;
};

/**
 * What `/api/data` ships: every request in a 5-minute bucket that shares
 * session + model + fast-mode + source, collapsed into one row. Costs are
 * summed from per-request pricing on the server, so never re-derive them
 * from the token counts — tiering applies per request.
 */
export type UsageRow = {
  /** First request in the bucket. */
  t: number;
  /** Last request in the bucket. */
  te: number;
  /** Requests collapsed into this row. */
  n: number;
  p: string;
  s: string;
  m: string;
  f: 0 | 1;
  src?: Harness;
  /** Summed tokens. */
  i: number;
  o: number;
  cc: number;
  cr: number;
  /** Summed USD, split by token type. */
  ci: number;
  co: number;
  cwc: number;
  crc: number;
};

export type SessionMeta = {
  summary?: string;
  firstPrompt?: string;
  parentSessionId?: string;
  threadSource?: 'main' | 'subagent' | string;
  agentNickname?: string;
  agentRole?: string;
};

export type TranscriptProvider = 'cc' | 'codex' | 'opencode' | 'pi' | 'omp';

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool' | 'event';

export type TranscriptEntryKind =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'summary'
  | 'attachment'
  | 'progress'
  | 'event';

export type TranscriptTokens = {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
};

export type TranscriptImage = {
  mediaType: string;
  data: string;
  label?: string;
};

export type TranscriptField = {
  label: string;
  value: string;
};

export type TranscriptEntry = {
  id: string;
  role: TranscriptRole;
  kind: TranscriptEntryKind;
  title: string;
  rawType: string;
  isSidechain: boolean;
  isCompactSummary: boolean;
  t?: number;
  text?: string;
  model?: string;
  /** Stable provider usage key used for cost deduplication in transcript stats. */
  usageKey?: string;
  /** Whether this usage belongs to the selected session's aggregate totals. */
  counted?: boolean;
  /** Whether this usage ran in provider fast mode. */
  fast?: 0 | 1;
  toolName?: string;
  tokens?: TranscriptTokens;
  meta?: string[];
  fields?: TranscriptField[];
  images?: TranscriptImage[];
};

export type TranscriptStream = {
  id: string;
  label: string;
  path: string;
  kind: 'main' | 'subagent';
  isSidechain: boolean;
  entries: TranscriptEntry[];
};

export type SessionTranscript = {
  sessionId: string;
  provider: TranscriptProvider;
  streams: TranscriptStream[];
  sourceFiles: number;
  totalEntries: number;
  missingRaw: boolean;
};

export type ProviderStats = {
  files: number;
  cachedFiles: number;
  parsedLines: number;
  tookMs: number;
};

export type ProviderInfo = {
  id: 'cc' | 'codex' | 'opencode' | 'pi' | 'omp';
  label: string;
  dataDir: string;
  cachePath: string;
  detected: boolean;
  stats: ProviderStats;
};

export type PromptDay = {
  /** Local-time YYYY-MM-DD. */
  date: string;
  /** ms since epoch at local midnight. */
  ms: number;
  /** Total prompts submitted that day. */
  count: number;
  /** Per-project prompt counts. */
  byProject: Record<string, number>;
  /** Per-session prompt counts. Used by `estimateMissingActivity` to skip
   * prompts whose session still has entries elsewhere (typical when a
   * session spans midnight). */
  bySession: Record<string, number>;
};

export type ApiData = {
  entries: UsageRow[];
  /** Requests behind `entries` — rows collapse several of them. */
  requests: number;
  sessionMeta: Record<string, SessionMeta>;
  /** Aggregated across all providers. Same shape every provider reports. */
  stats: ProviderStats;
  /** One entry per registered provider, detected or not. */
  providers: ProviderInfo[];
  /**
   * Per-day prompt counts read from `~/.claude/history.jsonl`. Distinct
   * from `entries` (assistant usage logs) because Claude Code's
   * `cleanupPeriodDays` deletes session JSONLs but leaves history.jsonl,
   * so this is the only complete record of "did the user run Claude on
   * day X" once sessions age out.
   */
  promptActivity: PromptDay[];
  generatedAt: number;
};

/** Tool that produced an entry. `'cc'` = Claude Code, default for legacy entries. */
export type Harness = 'cc' | 'codex' | 'opencode' | 'pi' | 'omp';

export type Filters = {
  /** ms since epoch — inclusive. */
  from: number | null;
  /** ms since epoch — exclusive. */
  to: number | null;
  projects: Set<string>;
  models: Set<string>;
  harnesses: Set<Harness>;
};

/** Resolve an entry's harness, applying the `'cc'` default for older entries. */
export function entryHarness(e: { src?: Harness }): Harness {
  return e.src ?? 'cc';
}

export const HARNESS_LABELS: Record<Harness, string> = {
  cc: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  omp: 'Oh My Pi',
};

export type Bucket =
  | { kind: 'hour'; ms: number }
  | { kind: 'day'; ms: number }
  | { kind: 'week'; ms: number }
  | { kind: 'month'; ms: number };
