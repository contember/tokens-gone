/**
 * Startup usage summary — a compact "what have I spent lately" digest
 * printed under the scan log when the CLI boots. Pure and self-contained
 * so it's cheap to test; `server.ts` just renders the lines.
 *
 * Windows are all calendar days aligned to local midnight: `today` and
 * `yesterday` are single days so they don't overlap; `7d`/`30d` are
 * today plus the previous 6/29 days (so "last 7 days" matches the
 * dashboard's "7 days" preset, not a rolling 168-hour window). Cost
 * reuses the server's pricing table (`costForRequest`).
 */

import { PLAIN, type Style } from './ansi.ts';
import { costForRequest } from './pricing.ts';
import type { Entry } from './types.ts';

const DAY_MS = 86_400_000;

const HARNESS_LABELS: Record<string, string> = {
  cc: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

function costForEntry(e: Entry): number {
  const explicit = explicitCost(e);
  if (explicit !== null) return explicit;
  return costForRequest(
    { input: e.i, output: e.o, cacheWrite: e.cc, cacheRead: e.cr },
    e.m,
    e.f === 1,
  );
}

function explicitCost(e: Entry): number | null {
  const has =
    e.ci !== undefined ||
    e.co !== undefined ||
    e.cwc !== undefined ||
    e.crc !== undefined;
  if (!has) return null;
  return (e.ci ?? 0) + (e.co ?? 0) + (e.cwc ?? 0) + (e.crc ?? 0);
}

/**
 * Collapse a raw model id to a short display label, grouping date-suffixed
 * variants together: `claude-opus-4-7-20260416` and `anthropic/claude-opus-4-7`
 * both become `opus-4.7`. Provider prefixes (`anthropic/`, `vertex_ai/`,
 * `us.anthropic.`) are stripped first.
 */
export function modelLabel(model: string): string {
  let m = model.toLowerCase();
  m = m.replace(/^[a-z_]+\//, ''); // anthropic/ , vertex_ai/ , openai/
  m = m.replace(/^[a-z]+\.[a-z]+\./, ''); // us.anthropic.
  m = m.replace(/^claude-/, '');
  // opus-4-7(-date) → opus-4.7 ; leaves already-dotted ids (gpt-5.2) alone.
  const v = m.match(/^([a-z]+)-(\d+)-(\d+)/);
  if (v) return `${v[1]}-${v[2]}.${v[3]}`;
  return m;
}

export type CostItem = { label: string; cost: number };

export type WindowStats = {
  cost: number;
  reqs: number;
  /** Cost per model label, descending. */
  byModel: CostItem[];
  /** Cost per harness label, descending. Only harnesses with activity. */
  byHarness: CostItem[];
};

export type WindowKey = 'today' | 'yesterday' | '7d' | '30d';

export type UsageSummary = Record<WindowKey, WindowStats>;

type Acc = {
  cost: number;
  reqs: number;
  models: Map<string, number>;
  harnesses: Map<string, number>;
};

function emptyAcc(): Acc {
  return { cost: 0, reqs: 0, models: new Map(), harnesses: new Map() };
}

function add(acc: Acc, e: Entry, cost: number): void {
  acc.cost += cost;
  acc.reqs++;
  acc.models.set(e.m, (acc.models.get(e.m) ?? 0) + cost);
  const h = e.src ?? 'cc';
  acc.harnesses.set(h, (acc.harnesses.get(h) ?? 0) + cost);
}

function finalize(acc: Acc): WindowStats {
  // Models share a label once date suffixes are stripped, so re-fold by label.
  const byLabel = new Map<string, number>();
  for (const [model, cost] of acc.models) {
    const label = modelLabel(model);
    byLabel.set(label, (byLabel.get(label) ?? 0) + cost);
  }
  const byModel = [...byLabel]
    .map(([label, cost]) => ({ label, cost }))
    .sort((a, b) => b.cost - a.cost);
  const byHarness = [...acc.harnesses]
    .map(([id, cost]) => ({ label: HARNESS_LABELS[id] ?? id, cost }))
    .sort((a, b) => b.cost - a.cost);
  return { cost: acc.cost, reqs: acc.reqs, byModel, byHarness };
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Build the usage summary. `entries` is assumed sorted ascending by `t`
 * (the server sorts before caching), so we walk from the tail and stop once
 * we fall out of the widest (30-day) window.
 */
export function summarizeUsage(entries: Entry[], now: number): UsageSummary {
  const startToday = startOfLocalDay(now);
  const startYesterday = startToday - DAY_MS;
  // Calendar windows: "last 7 days" = today + the previous 6 calendar days,
  // aligned to local midnight. Matches the dashboard's "7 days" preset
  // (src/components/ActiveFilters.tsx) and keeps the windows consistent with
  // today/yesterday above, which are also calendar days.
  const cut7 = startToday - 6 * DAY_MS;
  const cut30 = startToday - 29 * DAY_MS;
  const accs: Record<WindowKey, Acc> = {
    today: emptyAcc(),
    yesterday: emptyAcc(),
    '7d': emptyAcc(),
    '30d': emptyAcc(),
  };

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.t < cut30) break;
    if (e.t > now) continue; // ignore stray future timestamps
    const c = costForEntry(e);
    add(accs['30d'], e, c);
    if (e.t >= cut7) add(accs['7d'], e, c);
    if (e.t >= startToday) add(accs.today, e, c);
    else if (e.t >= startYesterday) add(accs.yesterday, e, c);
  }

  return {
    today: finalize(accs.today),
    yesterday: finalize(accs.yesterday),
    '7d': finalize(accs['7d']),
    '30d': finalize(accs['30d']),
  };
}

// Mirrors the dashboard's `fmtMoney` (src/format.ts) so CLI and UI agree.
function money(n: number): string {
  if (n === 0) return '$0';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n >= 0.0001) return `$${n.toFixed(4)}`;
  return '<$0.0001';
}

const MAX_BREAKDOWN_ITEMS = 6;

/** Render one breakdown block ("by model (30d)" + an aligned item per line). */
function breakdownBlock(heading: string, items: CostItem[], st: Style): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_BREAKDOWN_ITEMS);
  const rest = items.length - shown.length;
  const labelW = Math.max(...shown.map((it) => it.label.length));
  const moneyStrs = shown.map((it) => money(it.cost));
  const moneyW = Math.max(...moneyStrs.map((s) => s.length));
  const lines = [`  ${st.dim(heading)}`];
  shown.forEach((it, i) => {
    lines.push(`    ${it.label.padEnd(labelW)}  ${st.yellow(moneyStrs[i]!.padStart(moneyW))}`);
  });
  if (rest > 0) lines.push(`    ${st.dim(`+${rest} more`)}`);
  return lines;
}

/**
 * Render the summary as log lines (no trailing newline). Returns `[]` when
 * there's been no activity in 30 days so the caller can skip printing a wall
 * of zeros on a fresh install. Padding is computed before styling, so the
 * columns line up with or without colour.
 */
export function renderUsageSummary(summary: UsageSummary, st: Style = PLAIN): string[] {
  if (summary['30d'].reqs === 0) return [];

  const rows: { label: string; w: WindowStats }[] = [
    { label: 'today', w: summary.today },
    { label: 'yesterday', w: summary.yesterday },
    { label: 'last 7 days', w: summary['7d'] },
    { label: 'last 30 days', w: summary['30d'] },
  ];

  const labelW = Math.max(...rows.map((r) => r.label.length));
  const costStrs = rows.map((r) => money(r.w.cost));
  const costW = Math.max(...costStrs.map((s) => s.length));
  const reqStrs = rows.map((r) => r.w.reqs.toLocaleString('en-US'));
  const reqW = Math.max(...reqStrs.map((s) => s.length));

  const lines: string[] = [st.bold('Usage')];
  rows.forEach((r, i) => {
    const label = st.dim(r.label.padEnd(labelW));
    const cost = st.bold(st.yellow(costStrs[i]!.padStart(costW)));
    const reqs = st.dim(`${reqStrs[i]!.padStart(reqW)} reqs`);
    lines.push(`  ${label}  ${cost}  ${reqs}`);
  });

  const m30 = summary['30d'];
  const model = breakdownBlock('by model (30d)', m30.byModel, st);
  // Only worth showing harnesses when more than one contributed — otherwise
  // it just restates the 30-day total.
  const harness =
    m30.byHarness.length > 1 ? breakdownBlock('by harness (30d)', m30.byHarness, st) : [];
  if (model.length > 0 || harness.length > 0) {
    lines.push('');
    lines.push(...model, ...harness);
  }

  return lines;
}
