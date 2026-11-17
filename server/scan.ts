/**
 * Scans every provider and merges the results. Shared by the dashboard
 * server and the `report` subcommand, so both read the same entries.
 */

import { PROVIDERS, type Provider, type ProviderScanStats } from './providers/index.ts';
import type { Entry, SessionMeta } from './types.ts';

export type ProviderInfo = {
  id: Provider['id'];
  label: string;
  dataDir: string;
  cachePath: string;
  detected: boolean;
  stats: ProviderScanStats;
};

export type ProvidersScan = {
  /** Each provider's entries, sorted by time. */
  lists: Map<Provider['id'], Entry[]>;
  sessionMeta: Record<string, SessionMeta>;
  stats: ProviderScanStats;
  providers: ProviderInfo[];
};

const EMPTY_STATS: ProviderScanStats = {
  files: 0,
  cachedFiles: 0,
  parsedLines: 0,
  tookMs: 0,
};

/**
 * Scan every detected provider in parallel and merge. Undetected providers
 * still appear in the result with empty stats so the UI can show "Codex:
 * not detected" without special-casing.
 */
export async function scanProviders(): Promise<ProvidersScan> {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => {
      const dataDir = p.defaultDataDir();
      const cachePath = p.defaultCachePath();
      const detected = p.detect(dataDir);
      if (!detected) {
        return {
          info: { id: p.id, label: p.label, dataDir, cachePath, detected, stats: EMPTY_STATS },
          entries: [] as Entry[],
          sessionMeta: {} as Record<string, SessionMeta>,
        };
      }
      const r = await p.scan();
      return {
        info: { id: p.id, label: p.label, dataDir, cachePath, detected, stats: r.stats },
        entries: r.entries,
        sessionMeta: r.sessionMeta,
      };
    }),
  );

  const lists = new Map<Provider['id'], Entry[]>();
  let sessionMeta: Record<string, SessionMeta> = {};
  const providers: ProviderInfo[] = [];
  for (const r of results) {
    providers.push(r.info);
    lists.set(r.info.id, r.entries);
    // Session ID spaces don't collide in practice (all UUIDs), so a simple
    // spread merge is fine. Later providers win on collision, which is
    // intentional: it's how we'd preserve a provider's own labels over a
    // stale Claude-side entry if we ever shared IDs.
    sessionMeta = { ...sessionMeta, ...r.sessionMeta };
  }

  const stats = providers.reduce<ProviderScanStats>(
    (acc, p) => ({
      files: acc.files + p.stats.files,
      cachedFiles: acc.cachedFiles + p.stats.cachedFiles,
      parsedLines: acc.parsedLines + p.stats.parsedLines,
      tookMs: Math.max(acc.tookMs, p.stats.tookMs),
    }),
    { ...EMPTY_STATS },
  );

  return { lists, sessionMeta, stats, providers };
}
