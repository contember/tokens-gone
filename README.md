# ccdashboard

Local web dashboard for Claude Code usage. Reads `~/.claude/projects/**/*.jsonl`,
aggregates tokens and costs, lets you slice the data interactively.

## Why

`ccusage` works but is slow (tens of seconds on real data) and refetches LiteLLM
pricing every run. This is the same idea but:

- Cold scan: ~8s for 1.7GB of JSONL (5000+ files); warm: ~700ms.
- Hardcoded Anthropic pricing — no network requests, ever.
- Browser UI with click-to-filter on charts, models, projects, sessions.

## Run

```bash
bun install
bun run build              # build the SPA into dist/
bun run start              # serve on http://localhost:5174
```

For development:

```bash
bun run dev                # backend in one terminal
bun run dev:client         # vite dev server in another, proxied to backend
# → http://localhost:5173
```

## Test

```bash
bun test
bun run typecheck
```

## How it works

- `server/scanner.ts` walks `~/.claude/projects/`, parses JSONL streamingly,
  caches parsed entries on disk keyed by `(path, size, mtime)`. Unchanged
  files are reused verbatim; appended files are tail-parsed.
- `server/pricing.ts` resolves Anthropic Claude pricing by model name
  substring (matches `claude-opus-4-7`, `anthropic/claude-sonnet-4-6`, etc.),
  with tiered pricing for Sonnet >200k and a 6× fast-mode multiplier for Opus.
- `server/server.ts` exposes `/api/data` (gzipped) and `/api/refresh`.
- The SPA loads all entries once and re-aggregates client-side on every
  filter change — fast enough for ~300k entries.

## Configuration

- `CLAUDE_CONFIG_DIR` — override the Claude data dir (default `~/.claude`).
- `PORT` — server port (default 5174).
- Cache lives at `~/.cache/ccdashboard/cache.json`. Delete it to force a
  full re-scan.
