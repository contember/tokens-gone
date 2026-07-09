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
  src?: 'cc' | 'codex' | 'opencode' | 'pi';
};

export type SessionMeta = {
  summary?: string;
  firstPrompt?: string;
  parentSessionId?: string;
  threadSource?: 'main' | 'subagent' | string;
  agentNickname?: string;
  agentRole?: string;
};

export type TranscriptProvider = 'cc' | 'codex' | 'opencode' | 'pi';

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
  id: 'cc' | 'codex' | 'opencode' | 'pi';
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
  entries: Entry[];
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
export type Harness = 'cc' | 'codex' | 'opencode' | 'pi';

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
};

export type Bucket =
  | { kind: 'hour'; ms: number }
  | { kind: 'day'; ms: number }
  | { kind: 'week'; ms: number }
  | { kind: 'month'; ms: number };
