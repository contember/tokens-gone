# tokens-gone

Local web dashboard for AI coding agent token usage and cost. Reads Claude
Code, Codex, OpenCode, and Pi session logs, aggregates tokens and dollars, and
lets you slice the data interactively.

## Run

```bash
npx tokens-gone
```

That's it — it builds nothing on your machine, starts a local HTTP server,
and opens your browser at the dashboard. Subsequent runs reuse the on-disk
parse caches (`~/.cache/tokens-gone/*.json`), so warm scans are sub-second even
with thousands of session files.

### Flags

```
-p, --port <n>   Port to listen on (default 27821, or $PORT)
--no-open        Don't open the browser
-h, --help       Show help
-v, --version    Print version
```

### Environment

- `CLAUDE_CONFIG_DIR` — override the Claude data dir (default `~/.claude`).
- `CODEX_HOME` — override the Codex data dir (default `~/.codex`).
- `XDG_DATA_HOME` — where OpenCode keeps `opencode/opencode.db` (default
  `~/.local/share`). Reading it needs Node 22.5+ for `node:sqlite`; on older
  Node the other providers still work and OpenCode is skipped.
- `PI_CODING_AGENT_DIR` — override the Pi agent dir (default `~/.pi/agent`).
- `PI_CODING_AGENT_SESSION_DIR` — override the Pi sessions dir directly.
- `PORT` — same as `--port`.

## Why

`ccusage` works but is slow (tens of seconds on real data) and refetches
LiteLLM pricing every run. tokens-gone is the same idea but:

- Cold scan: ~8s for 1.7GB of JSONL (5000+ files); warm: ~700ms.
- Hardcoded Anthropic and OpenAI pricing — no network requests, ever.
- Browser UI with click-to-filter on charts, models, projects, sessions.

## How it works

- `server/providers/*` walk provider-specific JSONL directories, parse logs
  streamingly, and cache parsed entries on disk keyed by `(path, size, mtime)`.
  Unchanged files are reused verbatim; appended files are tail-parsed. OpenCode
  is the exception: it stores sessions in SQLite, so its provider reads the DB
  read-only and caches per session instead of per file.
- `server/pricing.ts` resolves Anthropic Claude and OpenAI GPT pricing by model
  name, including provider-prefixed and date-suffixed model IDs. It accounts
  for provider-specific caching, tiered pricing, and fast-mode rates.
- `server/server.ts` exposes `/api/data` (gzipped) and `/api/refresh`.
- The SPA loads all entries once and re-aggregates client-side on every
  filter change — fast enough for ~300k entries.

## Development

Requires [Bun](https://bun.sh) for the dev/test loop. The published package
runs on plain Node 20+.

```bash
bun install
bun run dev                # backend on :27821 + vite on :5173 (open :5173)
bun run dev:server         # just the backend (--hot)
bun run dev:client         # just vite

bun test
bun run typecheck
bun run build              # vite build + esbuild bundle of the server CLI
```

## License

MIT
