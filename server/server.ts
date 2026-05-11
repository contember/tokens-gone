/**
 * tokens-gone server.
 *
 * Runs the scan eagerly at startup and serves the cached result. POST
 * /api/refresh re-runs the scan (incremental — usually <1s once the disk
 * cache is warm) and returns updated stats.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { scan, defaultClaudeProjectsDir, defaultCachePath } from './scanner.ts';
import type { Entry, SessionMeta } from './types.ts';

type Cache = {
  entries: Entry[];
  sessionMeta: Record<string, SessionMeta>;
  stats: { files: number; cachedFiles: number; parsedLines: number; tookMs: number };
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
  const port = opts.port ?? Number(process.env.PORT ?? 5174);
  const host = opts.host ?? '127.0.0.1';
  const dist = resolveDistDir();

  let cached: Cache | null = null;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const result = await scan();
      cached = { ...result, generatedAt: Date.now() };
      inFlight = null;
    })();
    return inFlight;
  }

  async function api(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
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
        generatedAt: cached!.generatedAt,
      });
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
        generatedAt: cached!.generatedAt,
        projectsDir: defaultClaudeProjectsDir(),
        cachePath: defaultCachePath(),
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
        `tokens-gone: dist/ not built.\n\nRun "bun run build" (production) or run "bun run dev" and "bun run dev:client" in parallel for development.\n`,
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
        await api(req, res, url.pathname);
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
  console.log(`Projects: ${defaultClaudeProjectsDir()}`);
  console.log(`Cache:    ${defaultCachePath()}`);

  refresh()
    .then(() => {
      if (cached) {
        console.log(
          `Loaded ${cached.entries.length} entries from ${cached.stats.files} files (${cached.stats.cachedFiles} cached) in ${cached.stats.tookMs}ms`,
        );
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
