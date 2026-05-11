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
  /** Source of the entry. Missing means Claude Code. */
  src?: 'cc' | 'codex' | 'opencode';
};

export type SessionMeta = {
  summary?: string;
  firstPrompt?: string;
};

export type ApiData = {
  entries: Entry[];
  sessionMeta: Record<string, SessionMeta>;
  stats: {
    files: number;
    cachedFiles: number;
    parsedLines: number;
    tookMs: number;
  };
  /** Per-source breakdown — present from server v0.2+. Optional for backward compat. */
  sources?: {
    cc: { files: number; cachedFiles: number; parsedLines: number; tookMs: number };
    codex: { files: number; cachedFiles: number; parsedLines: number; tookMs: number };
  };
  generatedAt: number;
  projectsDir: string;
  cachePath: string;
  /** Set when codex sessions are detected; null otherwise. */
  codexSessionsDir?: string | null;
};

export type Filters = {
  /** ms since epoch — inclusive. */
  from: number | null;
  /** ms since epoch — exclusive. */
  to: number | null;
  projects: Set<string>;
  models: Set<string>;
};

export type Bucket =
  | { kind: 'hour'; ms: number }
  | { kind: 'day'; ms: number }
  | { kind: 'week'; ms: number }
  | { kind: 'month'; ms: number };
