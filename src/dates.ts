const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local midnight `days` calendar days after the local day that contains `ms`.
 * Steps by calendar day, so a DST switch in between does not shift the hour.
 */
export function shiftLocalDay(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** Local midnight that starts the local day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  return shiftLocalDay(ms, 0);
}

/**
 * The local calendar day containing `ms` as a half-open `[from, to)` range,
 * midnight to the next midnight: 23 or 25 h long on a DST switch day.
 */
export function localDayRange(ms: number): { from: number; to: number } {
  return { from: shiftLocalDay(ms, 0), to: shiftLocalDay(ms, 1) };
}

/**
 * The day a `[from, to)` range selects, as its local midnight, when the range
 * is exactly one whole local day; otherwise null.
 */
export function selectedLocalDay(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  const day = localDayRange(from);
  return day.from === from && day.to === to ? from : null;
}

/**
 * Local midnight of a `YYYY-MM-DD` date, or null when it is not a real date.
 * Local, not UTC, to match the presets, the heatmap and `report`.
 */
export function parseLocalDate(value: string): number | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date.getTime();
}
