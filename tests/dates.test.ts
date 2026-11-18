import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { daily } from '../src/aggregate';
import { localDayRange, parseLocalDate, selectedLocalDay, shiftLocalDay } from '../src/dates';
import type { UsageRow } from '../src/types';

const HOUR = 3_600_000;

/** The range the date inputs set when both pick `value`. */
function inputRange(value: string): { from: number; to: number } {
  const day = parseLocalDate(value);
  if (day === null) throw new Error(`not a date: ${value}`);
  return localDayRange(day);
}

function row(t: number): UsageRow {
  return { t, te: t, n: 1, p: 'demo', s: 'sess', m: 'claude-sonnet-4-6', f: 0, i: 1, o: 1, cc: 0, cr: 0, ci: 0, co: 0.01, cwc: 0, crc: 0 };
}

describe('local days in Europe/Prague', () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    // East of UTC, DST from 2026-03-29 (23 h day) to 2026-10-25 (25 h day).
    process.env.TZ = 'Europe/Prague';
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  describe('parseLocalDate', () => {
    it('reads a date input value as local midnight, not UTC midnight', () => {
      expect(parseLocalDate('2026-10-25')).toBe(Date.parse('2026-10-24T22:00:00Z'));
      expect(parseLocalDate('2026-10-25')).not.toBe(Date.parse('2026-10-25'));
    });

    it('rejects empty and impossible dates', () => {
      expect(parseLocalDate('')).toBeNull();
      expect(parseLocalDate('2026-02-30')).toBeNull();
      expect(parseLocalDate('2026-3-8')).toBeNull();
    });
  });

  describe('localDayRange', () => {
    it('spans the 23 h spring-forward day from midnight to midnight', () => {
      expect(inputRange('2026-03-29')).toEqual({
        from: Date.parse('2026-03-28T23:00:00Z'),
        to: Date.parse('2026-03-29T22:00:00Z'),
      });
      const { from, to } = inputRange('2026-03-29');
      expect(to - from).toBe(23 * HOUR);
    });

    it('spans the 25 h fall-back day from midnight to midnight', () => {
      expect(inputRange('2026-10-25')).toEqual({
        from: Date.parse('2026-10-24T22:00:00Z'),
        to: Date.parse('2026-10-25T23:00:00Z'),
      });
      const { from, to } = inputRange('2026-10-25');
      expect(to - from).toBe(25 * HOUR);
    });

    it('gives the same day for any instant inside it', () => {
      expect(localDayRange(Date.parse('2026-10-25T22:30:00Z'))).toEqual(inputRange('2026-10-25'));
    });
  });

  describe('selectedLocalDay', () => {
    it('selects a whole DST day set by the date inputs', () => {
      for (const value of ['2026-03-29', '2026-10-25']) {
        const { from, to } = inputRange(value);
        expect(selectedLocalDay(from, to)).toBe(from);
      }
    });

    it('rejects a fixed 24 h range on a DST day, partial days and open ranges', () => {
      const day = inputRange('2026-10-25').from;
      expect(selectedLocalDay(day, day + 24 * HOUR)).toBeNull();
      expect(selectedLocalDay(day + HOUR, shiftLocalDay(day, 1))).toBeNull();
      expect(selectedLocalDay(day, shiftLocalDay(day, 2))).toBeNull();
      expect(selectedLocalDay(day, null)).toBeNull();
      expect(selectedLocalDay(null, null)).toBeNull();
    });
  });

  describe('heatmap days across DST', () => {
    // Same window shape as the dashboard: a year ending today, here 2026-11-18.
    // Built per test, since TZ is set in beforeEach.
    function yearDays() {
      const now = Date.parse('2026-11-18T11:00:00Z');
      const window = { from: shiftLocalDay(now, -364), to: shiftLocalDay(now, 1) };
      return daily([row(Date.parse('2026-10-25T11:00:00Z'))], window.from, window.to);
    }

    it('keys every cell by the local midnight of its own date', () => {
      const days = yearDays();
      expect(days).toHaveLength(365);
      expect(new Set(days.map((d) => d.date)).size).toBe(365);
      for (const d of days) expect<number | null>(d.ms).toBe(parseLocalDate(d.date));
    });

    it('selects the same range on a cell click as the date inputs, and highlights it', () => {
      const days = yearDays();
      for (const value of ['2026-03-29', '2026-10-25']) {
        const cell = days.find((d) => d.date === value);
        if (!cell) throw new Error(`no cell for ${value}`);
        const clicked = localDayRange(cell.ms);
        expect(clicked).toEqual(inputRange(value));
        expect(selectedLocalDay(clicked.from, clicked.to)).toBe(cell.ms);
      }
    });
  });
});
