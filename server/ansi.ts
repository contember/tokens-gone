/**
 * Minimal ANSI styling for the CLI's startup output. `PLAIN` returns the
 * string untouched, so callers stay branch-free and tests can assert on
 * plain text.
 */

export type Style = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  underline: (s: string) => string;
};

const identity = (s: string): string => s;

export const PLAIN: Style = {
  bold: identity,
  dim: identity,
  cyan: identity,
  green: identity,
  yellow: identity,
  red: identity,
  underline: identity,
};

function wrap(open: number, close: number): (s: string) => string {
  return (s) => `\x1b[${open}m${s}\x1b[${close}m`;
}

const COLOR: Style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  cyan: wrap(36, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  red: wrap(31, 39),
  underline: wrap(4, 24),
};

/** Honours NO_COLOR / FORCE_COLOR, otherwise colours only a real terminal. */
export function colorSupported(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '') return force !== '0';
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

export function createStyle(enabled = colorSupported()): Style {
  return enabled ? COLOR : PLAIN;
}
