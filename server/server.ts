/**
 * tokens-gone server.
 *
 * Runs the scan eagerly at startup and serves the cached result. POST
 * /api/refresh re-runs the scan (incremental — usually <1s once the disk
 * cache is warm) and returns updated stats.
 *
 * The server is provider-agnostic: it iterates `PROVIDERS`, asks each one
 * to scan, concatenates entries, and re-sorts. Adding a new harness only
 * touches `./providers/`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PROVIDERS, type Provider, type ProviderScanStats } from './providers/index.ts';
import { loadPromptDays, type PromptDay } from './promptHistory.ts';
import { renderUsageSummary, summarizeUsage } from './summary.ts';
import type { Entry, SessionMeta } from './types.ts';

type ProviderInfo = {
  id: Provider['id'];
  label: string;
  dataDir: string;
  cachePath: string;
  detected: boolean;
  stats: ProviderScanStats;
};

type Cache = {
  entries: Entry[];
  sessionMeta: Record<string, SessionMeta>;
  stats: ProviderScanStats;
  providers: ProviderInfo[];
  promptActivity: PromptDay[];
  generatedAt: number;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Resolve where the built SPA lives. The server file moves between
// `server/server.ts` (dev, run by bun) and `dist/cli.js` (published, run by
// node), so we probe both layouts.
function resolveDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'dist'), here, join(here, '..')];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return candidates[0]!;
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  data: unknown,
  status = 200,
): void {
  const body = JSON.stringify(data);
  const accept = req.headers['accept-encoding'] ?? '';
  const acceptsGzip = typeof accept === 'string' && accept.includes('gzip');
  if (acceptsGzip && body.length > 5_000) {
    const gz = gzipSync(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'cache-control': 'no-store',
      'content-length': gz.byteLength,
    });
    res.end(gz);
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const EMPTY_STATS: ProviderScanStats = {
  files: 0,
  cachedFiles: 0,
  parsedLines: 0,
  tookMs: 0,
};

// Heatmap renders ~365 days; load a bit more so monthly view boundaries
// have headroom and the first run doesn't truncate just-recent activity.
const PROMPT_HISTORY_WINDOW_DAYS = 400;

async function runScan(): Promise<Omit<Cache, 'generatedAt'>> {
  const promptFromMs = Date.now() - PROMPT_HISTORY_WINDOW_DAYS * 86400000;
  const [providerResults, promptActivity] = await Promise.all([
    scanProviders(),
    loadPromptDays({ fromMs: promptFromMs }).catch(() => [] as PromptDay[]),
  ]);
  return { ...providerResults, promptActivity };
}

/**
 * Scan every detected provider in parallel and merge. Undetected providers
 * still appear in the result with empty stats so the UI can show "Codex:
 * not detected" without special-casing.
 */
async function scanProviders(): Promise<Omit<Cache, 'generatedAt' | 'promptActivity'>> {
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

  const entries: Entry[] = [];
  let sessionMeta: Record<string, SessionMeta> = {};
  const providers: ProviderInfo[] = [];
  for (const r of results) {
    providers.push(r.info);
    for (const e of r.entries) entries.push(e);
    // Session ID spaces don't collide in practice (all UUIDs), so a simple
    // spread merge is fine. Later providers win on collision, which is
    // intentional: it's how we'd preserve a provider's own labels over a
    // stale Claude-side entry if we ever shared IDs.
    sessionMeta = { ...sessionMeta, ...r.sessionMeta };
  }
  entries.sort((a, b) => a.t - b.t);

  const stats = providers.reduce<ProviderScanStats>(
    (acc, p) => ({
      files: acc.files + p.stats.files,
      cachedFiles: acc.cachedFiles + p.stats.cachedFiles,
      parsedLines: acc.parsedLines + p.stats.parsedLines,
      tookMs: Math.max(acc.tookMs, p.stats.tookMs),
    }),
    { ...EMPTY_STATS },
  );

  return { entries, sessionMeta, stats, providers };
}

export type StartOptions = {
  port?: number;
  host?: string;
};

export type RunningServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? Number(process.env.PORT ?? 27821);
  const host = opts.host ?? '127.0.0.1';
  const dist = resolveDistDir();

  let cached: Cache | null = null;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const result = await runScan();
      cached = { ...result, generatedAt: Date.now() };
      inFlight = null;
    })();
    return inFlight;
  }

  function providerForSession(sessionId: string): Provider | undefined {
    if (!cached) return undefined;
    for (const e of cached.entries) {
      if (e.s !== sessionId) continue;
      const providerId = e.src ?? 'cc';
      return PROVIDERS.find((p) => p.id === providerId);
    }
    return undefined;
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const pathname = url.pathname;
    if (pathname === '/api/health') {
      sendJson(req, res, { ok: true });
      return;
    }

    if (pathname === '/api/refresh' && req.method === 'POST') {
      await refresh();
      sendJson(req, res, {
        ok: true,
        entries: cached!.entries.length,
        stats: cached!.stats,
        providers: cached!.providers,
        generatedAt: cached!.generatedAt,
      });
      return;
    }

    if (pathname === '/api/session-transcript') {
      if (req.method !== 'GET') {
        sendJson(req, res, { error: 'Method Not Allowed' }, 405);
        return;
      }
      const sessionId = url.searchParams.get('session');
      if (!sessionId) {
        sendJson(req, res, { error: 'Missing session query parameter' }, 400);
        return;
      }
      if (!cached) await refresh();
      const provider = providerForSession(sessionId);
      if (!provider?.readTranscript) {
        sendJson(req, res, { error: 'No raw transcript reader for this session' }, 404);
        return;
      }
      const transcript = await provider.readTranscript(sessionId);
      sendJson(req, res, transcript);
      return;
    }

    if (pathname === '/api/data') {
      if (!cached) await refresh();
      // Strip the internal hash field — the client doesn't need it and it
      // would add ~7MB to the JSON payload.
      const clientEntries = cached!.entries.map(({ h: _h, ...rest }) => rest);
      sendJson(req, res, {
        entries: clientEntries,
        sessionMeta: cached!.sessionMeta,
        stats: cached!.stats,
        providers: cached!.providers,
        promptActivity: cached!.promptActivity,
        generatedAt: cached!.generatedAt,
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!existsSync(dist)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        `tokens-gone: dist/ not built.\n\nRun "bun run build" (production) or "bun run dev" (development — starts server + Vite, open http://localhost:5173).\n`,
      );
      return;
    }
    const candidates = [
      join(dist, pathname),
      join(dist, pathname, 'index.html'),
      join(dist, 'index.html'),
    ];
    for (const candidate of candidates) {
      if (!candidate.startsWith(dist)) continue;
      try {
        const s = await stat(candidate);
        if (!s.isFile()) continue;
      } catch {
        continue;
      }
      const type = MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      createReadStream(candidate).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await api(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      console.error('Request error', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = (server.address() as { port: number }).port;
  const url = `http://localhost:${actualPort}`;

  console.log(`tokens-gone ready on ${url}`);
  for (const p of PROVIDERS) {
    const dir = p.defaultDataDir();
    const detected = p.detect(dir);
    console.log(`${p.label.padEnd(12)} ${detected ? dir : '(not detected)'}`);
  }

  refresh()
    .then(() => {
      if (!cached) return;
      const detected = cached.providers.filter((p) => p.detected);
      const parts = detected.map(
        (p) => `${p.label}: ${p.stats.files} files (${p.stats.cachedFiles} cached)`,
      );
      console.log(
        `Loaded ${cached.entries.length} entries — ${parts.join(', ')} in ${cached.stats.tookMs}ms`,
      );
      const summary = renderUsageSummary(summarizeUsage(cached.entries, Date.now()));
      if (summary.length > 0) {
        console.log('');
        for (const line of summary) console.log(line);
      }
    })
    .catch((err) => console.error('Initial scan failed', err));

  return {
    url,
    port: actualPort,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

// When this module is the entry (bun run server/server.ts), start immediately.
// We deliberately don't compare against `import.meta.url` because that would
// also fire when the file is bundled into dist/cli.js, leading to a double
// startServer() call.
const entry = process.argv[1] ?? '';
if (entry.endsWith('/server.ts') || entry.endsWith('\\server.ts')) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
