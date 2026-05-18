/**
 * `~/.claude/history.jsonl` is Claude Code's user-prompt log: one line per
 * prompt submitted, with `{ timestamp, project, sessionId, display }`.
 *
 * Why we read it separately from session JSONLs: `cleanupPeriodDays`
 * (default 30) deletes `~/.claude/projects/**\/*.jsonl` but leaves
 * `history.jsonl` alone — so this is the only complete source of "did the
 * user use Claude on day X" once the sessions are gone.
 *
 * No tokens or cost here, just the prompt itself plus its project. That's
 * enough to drive an activity heatmap.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

export type PromptDay = {
  /** Local-time YYYY-MM-DD. */
  date: string;
  /** ms since epoch at local midnight. */
  ms: number;
  /** Prompts submitted that day. */
  count: number;
  /** Per-project prompt counts (project = basename of the cwd). */
  byProject: Record<string, number>;
};

function defaultHistoryPath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'history.jsonl')
    : join(homedir(), '.claude', 'history.jsonl');
}

function localDayMs(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoDateFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type LoadPromptDaysOptions = {
  /** Inclusive lower bound, ms since epoch. */
  fromMs?: number;
  /** Exclusive upper bound, ms since epoch. */
  toMs?: number;
  /** Override the default history.jsonl path. */
  path?: string;
};

export async function loadPromptDays(opts: LoadPromptDaysOptions = {}): Promise<PromptDay[]> {
  const path = opts.path ?? defaultHistoryPath();
  if (!existsSync(path)) return [];

  const byDay = new Map<number, PromptDay>();
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.length < 30) continue;
    // Cheap pre-filter: every record has these two fields. Skips malformed
    // lines without paying for JSON.parse.
    if (line.indexOf('"timestamp"') === -1) continue;

    let rec: { timestamp?: number; project?: string };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    const t = rec.timestamp;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    if (opts.fromMs != null && t < opts.fromMs) continue;
    if (opts.toMs != null && t >= opts.toMs) continue;

    const dayMs = localDayMs(t);
    let day = byDay.get(dayMs);
    if (!day) {
      day = { date: isoDateFromMs(dayMs), ms: dayMs, count: 0, byProject: {} };
      byDay.set(dayMs, day);
    }
    day.count++;
    const project = typeof rec.project === 'string' ? basename(rec.project) : '';
    if (project) day.byProject[project] = (day.byProject[project] ?? 0) + 1;
  }

  return [...byDay.values()].sort((a, b) => a.ms - b.ms);
}
