declare global {
  // Replaced with a string literal at build time (scripts/build-cli.mjs).
  var __TOKENS_GONE_VERSION__: string | undefined;
}

export const VERSION = globalThis.__TOKENS_GONE_VERSION__ ?? 'dev';
