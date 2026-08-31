// Bundle server/cli.ts into dist/cli.js so the published package ships
// a single executable JS file with all server code inlined. Reads the
// version from package.json and injects it as a global so --version works.

import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));

await build({
  entryPoints: ['server/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Optional dev-time binding; the OpenCode provider falls back to node:sqlite.
  external: ['bun:sqlite'],
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    'globalThis.__TOKENS_GONE_VERSION__': JSON.stringify(pkg.version),
  },
  legalComments: 'none',
  minify: false,
  sourcemap: false,
});

await chmod('dist/cli.js', 0o755);
console.log(`built dist/cli.js (v${pkg.version})`);
