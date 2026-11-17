import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { localDayStart } from '../src/dates';

describe('localDayStart', () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    // A zone west of UTC with a DST switch on 2026-03-08, so UTC midnight
    // and a fixed 24 h day both give a different answer.
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it('reads a date input value as local midnight, not UTC midnight', () => {
    expect(localDayStart('2026-03-08')).toBe(Date.parse('2026-03-08T05:00:00Z'));
    expect(localDayStart('2026-03-08')).not.toBe(Date.parse('2026-03-08'));
  });

  it('ends the day at the next local midnight across a DST switch', () => {
    expect(localDayStart('2026-03-08', 1)).toBe(Date.parse('2026-03-09T04:00:00Z'));
  });

  it('rejects empty and impossible dates', () => {
    expect(localDayStart('')).toBeNull();
    expect(localDayStart('2026-02-30')).toBeNull();
    expect(localDayStart('2026-3-8')).toBeNull();
  });
});
