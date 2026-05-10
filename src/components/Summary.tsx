import type { Totals } from '../aggregate';
import { fmtInt, fmtMoney, fmtTokens } from '../format';

export function Summary({ totals }: { totals: Totals }) {
  return (
    <div className="panel">
      <h2>Summary</h2>
      <div className="summary-grid">
        <Kpi label="Cost" value={fmtMoney(totals.cost)} highlight />
        <Kpi label="Requests" value={fmtInt(totals.count)} />
        <Kpi label="Total tokens" value={fmtTokens(totals.total)} />
        <Kpi label="Input" value={fmtTokens(totals.input)} />
        <Kpi label="Output" value={fmtTokens(totals.output)} />
        <Kpi label="Cache write" value={fmtTokens(totals.cacheWrite)} />
        <Kpi label="Cache read" value={fmtTokens(totals.cacheRead)} />
        <Kpi
          label="Cache hit"
          value={
            totals.cacheRead + totals.cacheWrite > 0
              ? `${Math.round(
                  (totals.cacheRead / (totals.cacheRead + totals.cacheWrite)) * 100,
                )}%`
              : '–'
          }
        />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value ${highlight ? 'cost' : ''}`}>{value}</div>
    </div>
  );
}
