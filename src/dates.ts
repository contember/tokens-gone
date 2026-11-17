const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local midnight of a `YYYY-MM-DD` date shifted by `offsetDays` (1 gives the
 * end of that day), or null when it is not a real date. Local, not UTC, to
 * match the presets, the heatmap and `report`.
 */
export function localDayStart(value: string, offsetDays = 0): number | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return new Date(year, month, day + offsetDays).getTime();
}
