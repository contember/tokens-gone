import type { ActivityStats } from '../aggregate';
import { fmtMoney } from '../format';

/**
 * Compact stat row beneath the heatmap — active days, streaks, peak day.
 * Mirrors what Claude's own activity widget shows but lets us pin our own
 * metrics (peak-day cost). Visible only when activity data is non-empty.
 */
export function StatStrip({
  stats,
  burnPerHour,
}: {
  stats: ActivityStats;
  burnPerHour: number;
}) {
  return (
    <div className="stat-strip">
      <Stat label="Active days" value={`${stats.activeDays}`} sub={`of ${stats.totalDays}`} />
      <Stat label="Current streak" value={`${stats.currentStreak}`} sub={stats.currentStreak === 1 ? 'day' : 'days'} />
      <Stat label="Longest streak" value={`${stats.longestStreak}`} sub={stats.longestStreak === 1 ? 'day' : 'days'} />
      {stats.mostActiveDay && (
        <Stat
          label="Peak day"
          value={fmtMoney(stats.mostActiveDay.cost)}
          sub={formatPeakDate(stats.mostActiveDay.date)}
        />
      )}
      {burnPerHour > 0.01 && (
        <Stat
          label="Recent burn"
          value={fmtMoney(burnPerHour)}
          sub="per hour (last 1h)"
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="v">
        {value}
        {sub && <span className="unit">{sub}</span>}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

function formatPeakDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
