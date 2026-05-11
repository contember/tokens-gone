/**
 * `npx tokens-gone` entry point. Parses minimal CLI flags, starts the server,
 * and (unless --no-open) opens the user's default browser to the dashboard.
 * The shebang is injected by esbuild's banner during build.
 */

import { spawn } from 'node:child_process';
import { startServer } from './server.ts';

type Args = {
  port: number;
  open: boolean;
};

const HELP = `tokens-gone — local Claude Code usage dashboard

Usage: tokens-gone [options]

Options:
  -p, --port <n>   Port to listen on (default 5174, or $PORT)
  --no-open        Don't open the browser
  -h, --help       Show this help
  -v, --version    Print version

Environment:
  PORT                Same as --port
  CLAUDE_CONFIG_DIR   Override the Claude data dir (default ~/.claude)
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: Number(process.env.PORT ?? 5174),
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--version' || a === '-v') {
      // VERSION is replaced at build time via esbuild --define.
      process.stdout.write(`${(globalThis as any).__TOKENS_GONE_VERSION__ ?? 'dev'}\n`);
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
