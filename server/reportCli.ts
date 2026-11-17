/**
 * `tokens-gone report`: scans the logs like the server does and prints a
 * usage report on stdout. Diagnostics and errors go to stderr.
 *
 * Exit codes: 0 success, 1 the scan failed, 2 invalid arguments.
 */

import type { ProviderId } from './providers/types.ts';
import { buildReport, GROUP_BYS, PROVIDER_IDS, type GroupBy, type Report, type ReportOptions } from './report.ts';
import { scanProviders } from './scan.ts';

export const REPORT_HELP = `tokens-gone report — usage per session, project, model or day

Usage: tokens-gone report [options]

Scans the same logs as the dashboard and prints a report on stdout. No server
is started. Costs are API-equivalent USD from the dashboard's pricing.

Options:
  --since <time>        Only requests at or after this time
  --until <time>        Only requests before this time
                        <time> is a local date (YYYY-MM-DD) or an ISO time
                        (2026-11-16T09:30, 2026-11-16T08:30:00Z). A date in
                        --until includes that whole day.
  --project <text>      Only sessions whose cwd contains <text>, ignoring case
                        (the project name when the cwd is unknown). Repeatable.
  --provider <id>       Only this provider: ${PROVIDER_IDS.join(', ')} (cc is Claude Code).
                        Repeatable or comma-separated.
  --group-by <key>      session (default), project, model or day (local date)
  --format <format>     json, jsonl or table. Default: table when stdout is a
                        terminal, json otherwise.
  --json                Same as --format json
  --jsonl               Same as --format jsonl
  -h, --help            Show this help

Output:
  json    {"groupBy","since","until","rows":[...],"totals":{...}}
  jsonl   one row per line, without totals
  table   aligned columns for reading, with a total line

  Every row has firstAt, lastAt, requests, models, tokens {input, output,
  cacheRead, cacheWrite, total} and costUsd {input, output, cacheRead,
  cacheWrite, total}. Session rows add provider, sessionId, project, cwd,
  title and subagents: the usage of each subagent transcript, already
  included in the session's own numbers.

Exit codes:
  0  success
  1  scanning the logs failed
  2  invalid arguments

Examples:
  tokens-gone report --since 2026-11-16 --json
  tokens-gone report --since 2026-11-01 --until 2026-11-30 --group-by day
  tokens-gone report --provider cc --project webapp --jsonl | jq .costUsd.total
`;

type Format = 'json' | 'jsonl' | 'table';

type ReportArgs = ReportOptions & { format: Format };

class UsageError extends Error {}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Local midnight of a `YYYY-MM-DD` date, or undefined when the date does not exist. */
function localMidnight(value: string): number | undefined {
  const match = DATE.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const d = new Date(year, month, day);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return undefined;
  return d.getTime();
}

function parseTime(flag: string, value: string, endOfDay: boolean): number {
  const midnight = localMidnight(value);
  if (midnight !== undefined) {
    if (!endOfDay) return midnight;
    const d = new Date(midnight);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }
  // Date.parse rolls impossible dates over (02-30 → 03-02), so check the date part first.
  if (!DATE.test(value) && ISO_TIME.test(value) && localMidnight(value.slice(0, 10)) !== undefined) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  throw new UsageError(`${flag}: expected a date (YYYY-MM-DD) or an ISO time, got "${value}"`);
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.some((id) => id === value);
}

function isGroupBy(value: string): value is GroupBy {
  return GROUP_BYS.some((g) => g === value);
}

function isFormat(value: string): value is Format {
  return value === 'json' || value === 'jsonl' || value === 'table';
}

/** Returns undefined when help was requested. */
export function parseReportArgs(argv: string[], stdoutIsTty: boolean): ReportArgs | undefined {
  let format: Format | undefined;
  let groupBy: GroupBy = 'session';
  let since: number | undefined;
  let until: number | undefined;
  const projects: string[] = [];
  const providers: ProviderId[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string => {
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    const setFormat = (next: Format): void => {
      if (format !== undefined && format !== next) {
        throw new UsageError(`conflicting output formats: ${format} and ${next}`);
      }
      format = next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        return undefined;
      case '--since':
        since = parseTime(flag, value(), false);
        break;
      case '--until':
        until = parseTime(flag, value(), true);
        break;
      case '--project': {
        const v = value();
        if (v === '') throw new UsageError('--project needs a non-empty value');
        projects.push(v);
        break;
      }
      case '--provider':
        for (const v of value().split(',')) {
          if (!isProviderId(v)) {
            throw new UsageError(`--provider: unknown provider "${v}" (expected ${PROVIDER_IDS.join(', ')})`);
          }
          if (!providers.includes(v)) providers.push(v);
        }
        break;
      case '--group-by': {
        const v = value();
        if (!isGroupBy(v)) throw new UsageError(`--group-by: expected ${GROUP_BYS.join(', ')}, got "${v}"`);
        groupBy = v;
        break;
      }
      case '--format': {
        const v = value();
        if (!isFormat(v)) throw new UsageError(`--format: expected json, jsonl or table, got "${v}"`);
        setFormat(v);
        break;
      }
      case '--json':
        setFormat('json');
        break;
      case '--jsonl':
        setFormat('jsonl');
        break;
      default:
        throw new UsageError(arg.startsWith('-') ? `unknown option ${arg}` : `unexpected argument "${arg}"`);
    }
  }

  if (since !== undefined && until !== undefined && since >= until) {
    throw new UsageError('--since must be before --until');
  }
  return { format: format ?? (stdoutIsTty ? 'table' : 'json'), groupBy, since, until, projects, providers };
}

/** The format an error should be printed in, read leniently from arguments that may not parse. */
function requestedFormat(argv: string[]): Format {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' || arg === '--format=json' || (arg === '--format' && argv[i + 1] === 'json')) return 'json';
    if (arg === '--jsonl' || arg === '--format=jsonl' || (arg === '--format' && argv[i + 1] === 'jsonl')) return 'jsonl';
  }
  return 'table';
}

function printError(format: Format, code: 'usage' | 'scan', message: string): void {
  if (format === 'table') {
    process.stderr.write(`tokens-gone report: ${message}\n`);
    if (code === 'usage') process.stderr.write('Run "tokens-gone report --help" for usage.\n');
    return;
  }
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
}

const integer = new Intl.NumberFormat('en-US');

function usdText(v: number): string {
  return `$${v.toFixed(2)}`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderTable(report: Report): string {
  const keyHeaders: Record<GroupBy, string[]> = {
    session: ['STARTED', 'PROVIDER', 'PROJECT', 'SESSION'],
    project: ['PROJECT', 'SESSIONS'],
    model: ['MODEL', 'SESSIONS'],
    day: ['DAY', 'SESSIONS'],
  };
  const headers = [...keyHeaders[report.groupBy], 'REQ', 'INPUT', 'OUTPUT', 'CACHE READ', 'CACHE WRITE', 'COST'];
  const numeric = new Set(['SESSIONS', 'REQ', 'INPUT', 'OUTPUT', 'CACHE READ', 'CACHE WRITE', 'COST']);
  const lines: string[][] = [];
  const titles: string[] = [];
  for (const row of report.rows) {
    let key: string[];
    if ('sessionId' in row) {
      key = [shortTime(row.firstAt), row.provider, row.project, row.sessionId.slice(0, 8)];
      const subagents = row.subagents.length > 0 ? ` (+${row.subagents.length} subagents)` : '';
      titles.push(row.title ? `${oneLine(row.title, 60)}${subagents}` : subagents.trim());
    } else if ('day' in row) {
      key = [row.day, integer.format(row.sessions)];
    } else if ('model' in row) {
      key = [row.model, integer.format(row.sessions)];
    } else {
      key = [row.project, integer.format(row.sessions)];
    }
    lines.push([
      ...key,
      integer.format(row.requests),
      integer.format(row.tokens.input),
      integer.format(row.tokens.output),
      integer.format(row.tokens.cacheRead),
      integer.format(row.tokens.cacheWrite),
      usdText(row.costUsd.total),
    ]);
  }
  const t = report.totals;
  const totalKey: string[] = keyHeaders[report.groupBy].map((_, i) => (i === 0 ? 'TOTAL' : ''));
  if (report.groupBy !== 'session') totalKey[1] = integer.format(t.sessions);
  const total = [
    ...totalKey,
    integer.format(t.requests),
    integer.format(t.tokens.input),
    integer.format(t.tokens.output),
    integer.format(t.tokens.cacheRead),
    integer.format(t.tokens.cacheWrite),
    usdText(t.costUsd.total),
  ];

  const widths = headers.map((h, c) => Math.max(h.length, total[c]!.length, ...lines.map((l) => l[c]!.length)));
  const format = (cells: string[]) =>
    cells.map((cell, c) => (numeric.has(headers[c]!) ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!))).join('  ');
  const out = [format(headers)];
  lines.forEach((cells, k) => {
    const title = titles[k];
    out.push(title ? `${format(cells)}  ${title}` : format(cells));
  });
  out.push(format(total));
  return `${out.map((l) => l.trimEnd()).join('\n')}\n`;
}

export function renderReport(report: Report, format: Format): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'jsonl') return report.rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  return renderTable(report);
}

/** Runs the subcommand and returns the exit code. */
export async function runReport(argv: string[]): Promise<number> {
  let args: ReportArgs | undefined;
  try {
    args = parseReportArgs(argv, Boolean(process.stdout.isTTY));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    printError(requestedFormat(argv), 'usage', err.message);
    return 2;
  }
  if (!args) {
    process.stdout.write(REPORT_HELP);
    return 0;
  }

  let report: Report;
  try {
    const scan = await scanProviders();
    report = buildReport(
      (function* () {
        for (const list of scan.lists.values()) yield* list;
      })(),
      scan.sessionMeta,
      args,
    );
  } catch (err) {
    printError(args.format, 'scan', err instanceof Error ? err.message : String(err));
    return 1;
  }
  // A reader that stops early (`| head`) closes the pipe; that is not a failure.
  // No process.exit here: the scan's background cache writes must finish.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
  process.stdout.write(renderReport(report, args.format));
  return 0;
}
