import { useMemo, useState } from 'react';
import { fmtMoney } from '../format';

export type ChartPoint = {
  label: string;
  full: string;
  value: number;
  /** Stack segments (e.g. per-model cost). Drawn bottom-up. */
  segments?: { value: number; color: string; label: string }[];
};

/**
 * Thin-bar stacked chart with rich hover. The bars are narrow and
 * unlabeled by default — labels appear only on hover so the chart stays
 * readable at any density. Y axis uses three subtle grid lines (0 / mid /
 * max) with dollar labels in monospace, no axis line.
 *
 * Layout uses absolute positioning in pixels (resize-aware via SVG
 * `preserveAspectRatio`); we draw to a fixed 1000-wide viewBox so bar
 * spacing stays crisp without dynamic measurement.
 */
type Props = {
  data: ChartPoint[];
  height?: number;
};

const W = 1000;

export function BarChart({ data, height = 240 }: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const layout = useMemo(() => {
    if (data.length === 0) return null;
    const max = Math.max(1, ...data.map((d) => d.value));
    return { max };
  }, [data]);

  if (!layout || data.length === 0) {
    return <div className="empty">No data in range</div>;
  }

  const pad = { l: 56, r: 8, t: 8, b: 24 };
  const innerW = W - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const slot = innerW / data.length;
  const barW = Math.max(1, Math.min(slot - 1, 14));
  const offset = (slot - barW) / 2;

  const ticks = [0, 0.5, 1].map((f) => layout.max * f);

  const hoverPt = hoverIdx !== null ? data[hoverIdx] : null;
  const tooltipX = hoverIdx !== null ? pad.l + hoverIdx * slot + slot / 2 : 0;

  return (
    <div className="chart-wrap">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {ticks.map((v, i) => {
          const y = pad.t + innerH - (v / layout.max) * innerH;
          return (
            <g key={i}>
              <line
                x1={pad.l}
                x2={W - pad.r}
                y1={y}
                y2={y}
                stroke="var(--line-soft)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={pad.l - 8}
                y={y + 3}
                fill="var(--t-3)"
                fontSize={9}
                textAnchor="end"
                fontFamily="var(--mono)"
                letterSpacing="-0.02em"
              >
                {fmtMoney(v)}
              </text>
            </g>
          );
        })}

        {/* hover guideline */}
        {hoverIdx !== null && (
          <line
            x1={tooltipX}
            x2={tooltipX}
            y1={pad.t}
            y2={pad.t + innerH}
            stroke="var(--line-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {data.map((d, i) => {
          const x = pad.l + i * slot + offset;
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
                  width={barW}
                  height={Math.max(0, h)}
                  fill={seg.color}
                  opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.35}
                  onMouseEnter={() => setHoverIdx(i)}
                />
              );
            });
          }
          const h = (d.value / layout.max) * innerH;
          const y = pad.t + innerH - h;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barW}
              height={Math.max(0, h)}
              fill="var(--accent)"
              opacity={hoverIdx === null || hoverIdx === i ? 0.85 : 0.3}
              onMouseEnter={() => setHoverIdx(i)}
            />
          );
        })}

        {/* sparse x-axis labels: first, last, and every Nth */}
        {axisLabels(data).map((al) => (
          <text
            key={al.idx}
            x={pad.l + al.idx * slot + slot / 2}
            y={height - 6}
            fill="var(--t-3)"
            fontSize={9}
            textAnchor="middle"
            fontFamily="var(--mono)"
            letterSpacing="0.02em"
          >
            {al.label}
          </text>
        ))}
      </svg>

      {hoverPt && (
        <div
          className="chart-tooltip"
          style={{
            left: `calc(${(tooltipX / W) * 100}% - 80px)`,
            top: 4,
            position: 'absolute',
          }}
        >
          <div className="title">{hoverPt.full}</div>
          <div className="total">{fmtMoney(hoverPt.value)}</div>
          {hoverPt.segments?.map((s, i) => (
            <div className="row" key={i}>
              <span>
                <span className="swatch" style={{ background: s.color }} />
                {s.label}
              </span>
              <span>{fmtMoney(s.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function axisLabels(data: ChartPoint[]): { idx: number; label: string }[] {
  if (data.length === 0) return [];
  if (data.length <= 8) return data.map((d, i) => ({ idx: i, label: d.label }));
  const step = Math.ceil(data.length / 8);
  const out: { idx: number; label: string }[] = [];
  for (let i = 0; i < data.length; i += step) out.push({ idx: i, label: data[i]!.label });
  if (out[out.length - 1]!.idx !== data.length - 1) {
    out.push({ idx: data.length - 1, label: data[data.length - 1]!.label });
  }
  return out;
}
