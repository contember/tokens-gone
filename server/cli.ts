/**
 * `npx tokens-gone` entry point. Parses minimal CLI flags, starts the server,
 * and (unless --no-open) opens the user's default browser to the dashboard.
 * The shebang is injected by esbuild's banner during build.
 */

import { spawn } from 'node:child_process';
import { startServer } from './server.ts';
import { VERSION } from './version.ts';

type Args = {
  port: number;
  open: boolean;
};

const HELP = `tokens-gone — local AI coding agent usage dashboard

Usage: tokens-gone [options]

Options:
  -p, --port <n>   Port to listen on (default 27821, or $PORT)
  --no-open        Don't open the browser
  -h, --help       Show this help
  -v, --version    Print version

Environment:
  PORT                          Same as --port
  CLAUDE_CONFIG_DIR             Override the Claude data dir (default ~/.claude)
  CODEX_HOME                    Override the Codex data dir (default ~/.codex)
  XDG_DATA_HOME                 Where OpenCode and XDG-based OMP data live
  PI_CODING_AGENT_DIR           Override the Pi agent dir (default ~/.pi/agent)
  PI_CODING_AGENT_SESSION_DIR   Override the Pi sessions dir directly
  OMP_CODING_AGENT_DIR          Override the OMP agent dir (default ~/.omp/agent)
  OMP_CODING_AGENT_SESSION_DIR  Override the OMP sessions dir directly
  OMP_PROFILE                   Select an OMP profile
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: Number(process.env.PORT ?? 27821),
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--version' || a === '-v') {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    } else if (a === '--port' || a === '-p') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0 || v > 65535) {
        console.error(`Invalid port: ${argv[i]}`);
        process.exit(1);
      }
      args.port = v;
    } else if (a === '--no-open') {
      args.open = false;
    } else if (a && a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.stderr.write(HELP);
      process.exit(1);
    }
  }
  return args;
}

/**
 * The OpenCode provider reads a SQLite DB through node:sqlite, whose
 * ExperimentalWarning would land in the middle of the startup output.
 * Other warnings still reach Node's own handler.
 */
function hideSqliteExperimentalWarning(): void {
  const defaults = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
    for (const listener of defaults) listener(warning);
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // Browser launch failed — user can open the URL themselves.
    });
    child.unref();
  } catch {
    // Same — non-fatal.
  }
}

const args = parseArgs(process.argv.slice(2));
hideSqliteExperimentalWarning();
const running = await startServer({ port: args.port });
if (args.open) {
  openInBrowser(running.url);
}

process.on('SIGINT', () => {
  running.close().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  running.close().finally(() => process.exit(0));
});
