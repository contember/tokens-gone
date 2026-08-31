import { afterEach, describe, expect, it } from 'bun:test';
import { PLAIN, colorSupported, createStyle } from '../server/ansi';

const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR', 'TERM'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('createStyle', () => {
  it('is a no-op when disabled', () => {
    const st = createStyle(false);
    expect(st.bold('x')).toBe('x');
    expect(st.yellow('x')).toBe('x');
    expect(st).toBe(PLAIN);
  });

  it('wraps in ANSI codes when enabled', () => {
    const st = createStyle(true);
    expect(st.bold('x')).toBe('\x1b[1mx\x1b[22m');
    expect(st.cyan('x')).toBe('\x1b[36mx\x1b[39m');
  });
});

describe('colorSupported', () => {
  it('follows NO_COLOR, FORCE_COLOR and TERM before the TTY check', () => {
    delete process.env.FORCE_COLOR;
    delete process.env.TERM;
    process.env.NO_COLOR = '1';
    expect(colorSupported({ isTTY: true })).toBe(false);

    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    expect(colorSupported({ isTTY: false })).toBe(true);

    process.env.FORCE_COLOR = '0';
    expect(colorSupported({ isTTY: true })).toBe(false);
    delete process.env.FORCE_COLOR;

    process.env.TERM = 'dumb';
    expect(colorSupported({ isTTY: true })).toBe(false);
  });

  it('falls back to the stream being a TTY', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(colorSupported({ isTTY: true })).toBe(true);
    expect(colorSupported({})).toBe(false);
  });
});
