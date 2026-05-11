# tokens-gone

Local web dashboard for Claude Code token usage and cost. Reads
`~/.claude/projects/**/*.jsonl`, aggregates tokens and dollars, lets you slice
the data interactively.

## Run

```bash
npx tokens-gone
```

That's it — it builds nothing on your machine, starts a local HTTP server,
and opens your browser at the dashboard. Subsequent runs reuse the on-disk
parse cache (`~/.cache/tokens-gone/cache.json`), so warm scans are sub-second
even with thousands of session files.

### Flags

```
-p, --port <n>   Port to listen on (default 27821, or $PORT)
--no-open        Don't open the browser
-h, --help       Show help
-v, --version    Print version
```

### Environment

- `CLAUDE_CONFIG_DIR` — override the Claude data dir (default `~/.claude`).
- `PORT` — same as `--port`.

## Why

`ccusage` works but is slow (tens of seconds on real data) and refetches
LiteLLM pricing every run. tokens-gone is the same idea but:

- Cold scan: ~8s for 1.7GB of JSONL (5000+ files); warm: ~700ms.
- Hardcoded Anthropic pricing — no network requests, ever.
- Browser UI with click-to-filter on charts, models, projects, sessions.

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

## Development

Requires [Bun](https://bun.sh) for the dev/test loop. The published package
runs on plain Node 20+.

```bash
bun install
bun run dev                # backend on :27821
bun run dev:client         # vite on :5173 (proxied to backend)

bun test
bun run typecheck
bun run build              # vite build + esbuild bundle of the server CLI
```

## License

MIT
