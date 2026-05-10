/**
 * ccdashboard server.
 *
 * Runs the scan eagerly at startup and serves the cached result. POST
 * /api/refresh re-runs the scan (incremental — usually <1s once the disk
 * cache is warm) and returns updated stats.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { scan, defaultClaudeProjectsDir, defaultCachePath } from './scanner.ts';
import type { Entry } from './types.ts';

const PORT = Number(process.env.PORT ?? 5174);
const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

let cached: {
  entries: Entry[];
  stats: { files: number; cachedFiles: number; parsedLines: number; tookMs: number };
  generatedAt: number;
} | null = null;

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

/**
 * Serialize and (optionally) gzip a JSON response. Gzip kicks in only when
 * the client advertises support AND the body is large enough to be worth
 * compressing — the /api/data payload is the only one that hits this path
 * in practice (~40MB raw → ~3MB gzipped).
 */
function json(data: unknown, req: Request, init?: ResponseInit): Response {
  const body = JSON.stringify(data);
  const accept = req.headers.get('accept-encoding') ?? '';
  if (accept.includes('gzip') && body.length > 5_000) {
    return new Response(Bun.gzipSync(body), {
      ...init,
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'cache-control': 'no-store',
        ...(init?.headers ?? {}),
      },
    });
  }
  return new Response(body, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(init?.headers ?? {}),
    },
  });
}

async function api(req: Request, url: URL): Promise<Response> {
  if (url.pathname === '/api/health') {
    return json({ ok: true }, req);
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    await refresh();
    return json(
      {
        ok: true,
        entries: cached!.entries.length,
        stats: cached!.stats,
        generatedAt: cached!.generatedAt,
      },
      req,
    );
  }

  if (url.pathname === '/api/data') {
    if (!cached) await refresh();
    // Strip the internal hash field — the client doesn't need it and it
    // would add ~7MB to the JSON payload.
    const clientEntries = cached!.entries.map(({ h: _h, ...rest }) => rest);
    return json(
      {
        entries: clientEntries,
        stats: cached!.stats,
        generatedAt: cached!.generatedAt,
        projectsDir: defaultClaudeProjectsDir(),
        cachePath: defaultCachePath(),
      },
      req,
    );
  }

  return new Response('Not Found', { status: 404 });
}

async function serveStatic(url: URL): Promise<Response> {
  if (!existsSync(DIST)) {
    return new Response(
      `ccdashboard: dist/ not built.\n\nRun "bun run build" (production) or run "bun run dev" and "bun run dev:client" in parallel for development.\n`,
      { status: 200, headers: { 'content-type': 'text/plain' } },
    );
  }
  // Try the literal path, fall back to index.html for SPA routing.
  const candidates = [
    join(DIST, url.pathname),
    join(DIST, url.pathname, 'index.html'),
    join(DIST, 'index.html'),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith(DIST)) continue;
    const file = Bun.file(candidate);
    if (await file.exists()) {
      return new Response(file);
    }
  }
  return new Response('Not Found', { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(req, url);
      } catch (err) {
        console.error('API error', err);
        return json({ error: String(err) }, req, { status: 500 });
      }
    }
    return serveStatic(url);
  },
});

console.log(`ccdashboard ready on http://localhost:${server.port}`);
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
