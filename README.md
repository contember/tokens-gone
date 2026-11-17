# tokens-gone

Local web dashboard for AI coding agent token usage and cost. Reads Claude
Code, Codex, OpenCode V1 and V2, Pi, and Oh My Pi session logs, aggregates
tokens and cost, and lets you slice the data interactively.

## Run

```bash
npx tokens-gone
```

That's it — it builds nothing on your machine, starts a local HTTP server,
and opens your browser at the dashboard. Subsequent runs reuse the on-disk
parse caches in `~/.cache/tokens-gone/`, so warm scans skip unchanged files
even with thousands of session files.

### Flags

```
-p, --port <n>   Port to listen on (default 27821, or $PORT)
--no-open        Don't open the browser
-h, --help       Show help
-v, --version    Print version
```

### Report from the command line

`tokens-gone report` prints the same numbers as the dashboard without
starting a server, for scripts and agents. It reads the same logs and
caches and uses the same pricing.

```bash
npx tokens-gone report --since 2026-11-16 --group-by session --json
```

```json
{
  "groupBy": "session",
  "since": "2026-11-15T23:00:00.000Z",
  "until": null,
  "rows": [
    {
      "provider": "cc",
      "sessionId": "0b6f3c9e-…",
      "project": "webapp",
      "cwd": "/home/me/projects/webapp",
      "title": "Fix the login redirect",
      "firstAt": "2026-11-16T08:02:11.000Z",
      "lastAt": "2026-11-16T09:40:57.000Z",
      "requests": 212,
      "models": ["claude-opus-4-7"],
      "tokens": { "input": 1840, "output": 98211, "cacheRead": 21450032, "cacheWrite": 812044, "total": 22362127 },
      "costUsd": { "input": 0.0092, "output": 2.455275, "cacheRead": 10.725016, "cacheWrite": 5.075275, "total": 18.264766 },
      "subagents": [
        { "id": "a451c94714fcd87c8", "label": null, "firstAt": "…", "lastAt": "…", "requests": 31, "models": ["claude-opus-4-7"], "tokens": { … }, "costUsd": { … } }
      ]
    }
  ],
  "totals": { "firstAt": "…", "lastAt": "…", "requests": 212, "models": ["claude-opus-4-7"], "tokens": { … }, "costUsd": { … }, "sessions": 1 }
}
```

- One row per session. Subagent transcripts (Claude Code `subagents/`,
  Codex and OpenCode subagent sessions) count toward their parent session and
  are also listed under it in `subagents`.
- `--since` / `--until` take a local date (`2026-11-16`, `--until` includes
  that day) or an ISO time. `--project <text>` keeps sessions whose cwd
  contains the text, ignoring case (the project name where the cwd is not
  known). `--provider cc|codex|opencode|pi|omp` keeps one harness.
- `--group-by project|model|day` sums by those keys instead.
- `--json` prints one object with `rows` and `totals`, `--jsonl` one row per
  line, `--format table` aligned columns. Without a flag the output is a table
  on a terminal and JSON otherwise.
- Errors go to stderr; the exit code is 2 for invalid arguments and 1 when
  scanning fails.

Run `tokens-gone report --help` for every option.

### Environment

- `CLAUDE_CONFIG_DIR` — override the Claude data dir (default `~/.claude`).
- `CODEX_HOME` — override the Codex data dir (default `~/.codex`).
- `XDG_DATA_HOME` — where OpenCode keeps `opencode/opencode.db` (default
  `~/.local/share`) and where Oh My Pi may keep XDG-migrated sessions. Reading
  OpenCode needs Node 22.5+ for `node:sqlite`; on older Node versions the other
  providers still work and OpenCode is skipped.
- `PI_CODING_AGENT_DIR` — override the Pi agent dir (default `~/.pi/agent`).
- `PI_CODING_AGENT_SESSION_DIR` — override the Pi sessions dir directly.
- `OMP_CODING_AGENT_DIR` — override the Oh My Pi agent dir (default
  `~/.omp/agent`).
- `OMP_CODING_AGENT_SESSION_DIR` — override the Oh My Pi sessions dir directly.
- `OMP_PROFILE` — select an Oh My Pi profile.
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
  Unchanged files are reused verbatim; appended files are tail-parsed from the
  end of the last complete line. The Claude Code cache is split into one file
  per project, so a scan rewrites only the projects that changed. OpenCode
  V1 and V2 are the exception: they store sessions in SQLite, so their shared
  provider reads the DB read-only, deduplicates migrated messages, caches
  per session instead of per file, and skips the DB entirely while it and its
  WAL are unchanged.
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
