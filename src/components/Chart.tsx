import { useMemo } from 'react';
import { fmtMoney } from '../format';

export type ChartPoint = {
  label: string;
  value: number;
  /** Optional sub-segments (e.g. per-model stacks). */
  segments?: { value: number; color: string }[];
};

type Props = {
  data: ChartPoint[];
  yLabel?: string;
  height?: number;
};

export function BarChart({ data, yLabel, height = 200 }: Props) {
  const layout = useMemo(() => {
    if (data.length === 0) return null;
    const max = Math.max(1, ...data.map((d) => d.value));
    return { max };
  }, [data]);

  if (!layout || data.length === 0) {
    return <div className="muted" style={{ padding: 20 }}>No data</div>;
  }

  const w = 100; // viewBox width in %
  const pad = { l: 6, r: 1, t: 1, b: 4 };
  const innerW = w - pad.l - pad.r;
  const innerH = 100 - pad.t - pad.b;
  const barW = innerW / data.length;
  const barInner = Math.max(0.5, barW * 0.7);
  const gap = (barW - barInner) / 2;

  const tickValues = [0, 0.5, 1].map((f) => layout.max * f);

  return (
    <svg
      className="chart"
      style={{ height }}
      viewBox={`0 0 ${w} 100`}
      preserveAspectRatio="none"
    >
      {tickValues.map((v, i) => {
        const y = pad.t + innerH - (v / layout.max) * innerH;
        return (
          <line
            key={i}
            className="axis"
            x1={pad.l}
            x2={w - pad.r}
            y1={y}
            y2={y}
            strokeWidth={0.1}
            opacity={0.4}
          />
        );
      })}
      {data.map((d, i) => {
        const x = pad.l + i * barW + gap;
        if (d.segments && d.segments.length > 0) {
          let acc = 0;
          return d.segments.map((seg, j) => {
            const h = (seg.value / layout.max) * innerH;
            const y = pad.t + innerH - acc - h;
            acc += h;
            return (
              <rect
                key={`${i}-${j}`}
                x={x}
                y={y}
                width={barInner}
                height={Math.max(0, h)}
                fill={seg.color}
              >
                <title>
                  {d.label}: {fmtMoney(seg.value)}
                </title>
              </rect>
            );
          });
        }
        const h = (d.value / layout.max) * innerH;
        const y = pad.t + innerH - h;
        return (
          <rect
            key={i}
            className="bar"
            x={x}
            y={y}
            width={barInner}
            height={Math.max(0, h)}
          >
            <title>
              {d.label}: {fmtMoney(d.value)}
            </title>
          </rect>
        );
      })}
      {yLabel && (
        <text x={1} y={3} fontSize={3}>
          {yLabel}
        </text>
      )}
    </svg>
  );
}
