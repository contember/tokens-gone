/**
 * Collapses per-request entries into the rows `/api/data` ships.
 *
 * A million raw entries cost ~4s to serialize and ~140MB on the wire; the
 * dashboard never renders them individually (the per-request table in the
 * session detail fetches `/api/session-entries` instead), so we roll them
 * up ~15x before they leave the server.
 */

import { costBreakdownForEntry } from './pricing.ts';
import type { Entry, UsageRow } from './types.ts';

/** Bucket width. Divides evenly into an hour, so a row never straddles a
 * local-time hour boundary — every timezone offset is a multiple of 15min. */
export const ROLLUP_BUCKET_MS = 5 * 60_000;

const SRC_IDS: Record<string, number> = { cc: 0, codex: 1, opencode: 2, pi: 3 };

/** Costs are fractions of a cent; keeping full float precision would add
 * ~1.3MB of trailing digits to the payload for no visible accuracy. */
function nano(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/**
 * Group by (session, model, fast, source, time bucket) and sum.
 *
 * Cost is computed per entry and *then* summed: pricing tiers and the fast
 * multiplier apply per request, so re-pricing a row's summed tokens would
 * overcharge every bucket that crosses the 200k tier (~$5 on a $101k
 * dataset). Callers get exact costs in `ci`/`co`/`cwc`/`crc` and must not
 * re-derive them from the token counts.
 */
export function rollupEntries(entries: Entry[], requestCosts?: Float64Array): UsageRow[] {
  // Two-level map instead of one string key: hashing the session id once and
  // packing the rest into an integer is ~2x faster over a million entries.
  const bySession = new Map<string, Map<number, UsageRow>>();
  const modelIds = new Map<string, number>();

  for (let k = 0; k < entries.length; k++) {
    const e = entries[k]!;
    let inner = bySession.get(e.s);
    if (!inner) {
      inner = new Map();
      bySession.set(e.s, inner);
    }
    let modelId = modelIds.get(e.m);
    if (modelId === undefined) {
      modelId = modelIds.size;
      modelIds.set(e.m, modelId);
    }
    const key =
      Math.floor(e.t / ROLLUP_BUCKET_MS) * 65536 +
      modelId * 8 +
      (e.f ? 4 : 0) +
      (SRC_IDS[e.src ?? 'cc'] ?? 0);

    let row = inner.get(key);
    if (!row) {
      row = {
        t: e.t, te: e.t, n: 0,
        p: e.p, s: e.s, m: e.m, f: e.f, src: e.src,
        i: 0, o: 0, cc: 0, cr: 0,
        ci: 0, co: 0, cwc: 0, crc: 0,
      };
      inner.set(key, row);
    }

    if (e.t < row.t) row.t = e.t;
    if (e.t > row.te) row.te = e.t;
    row.n++;
    row.i += e.i;
    row.o += e.o;
    row.cc += e.cc;
    row.cr += e.cr;

    const c = costBreakdownForEntry(e);
    if (requestCosts) {
      requestCosts[k] = c.input + c.output + c.cacheWrite + c.cacheRead;
    }
    row.ci += c.input;
    row.co += c.output;
    row.cwc += c.cacheWrite;
    row.crc += c.cacheRead;
  }

  const rows: UsageRow[] = [];
  bySession.forEach((inner) =>
    inner.forEach((row) => {
      row.ci = nano(row.ci);
      row.co = nano(row.co);
      row.cwc = nano(row.cwc);
      row.crc = nano(row.crc);
      rows.push(row);
    }),
  );
  rows.sort((a, b) => a.t - b.t);
  return rows;
}
