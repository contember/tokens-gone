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
};

export type ApiData = {
  entries: Entry[];
  stats: {
    files: number;
    cachedFiles: number;
    parsedLines: number;
    tookMs: number;
  };
  generatedAt: number;
  projectsDir: string;
  cachePath: string;
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
