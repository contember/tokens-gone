import { useMemo } from 'react';
import type { Totals } from '../aggregate';
import { fmtInt, fmtMoney, fmtTokens } from '../format';
import { DecompBar, type Segment } from './DecompBar';

/**
 * Hero stat: huge cost number + a 4-segment decomposition bar showing
 * where the money actually went (input / output / cache write / cache read).
 * The bar repeats in tables — once you internalize the colors, every row
 * becomes readable at a glance.
 */
export function Hero({
  totals,
  costByType,
  contextLine,
}: {
  totals: Totals;
  costByType: { input: number; output: number; cwrite: number; cread: number };
  contextLine: string;
}) {
  const segments = useMemo<Segment[]>(
    () => [
      { cls: 'input', value: costByType.input, label: `input $${costByType.input.toFixed(2)}` },
      { cls: 'output', value: costByType.output, label: `output $${costByType.output.toFixed(2)}` },
      { cls: 'cwrite', value: costByType.cwrite, label: `cache write $${costByType.cwrite.toFixed(2)}` },
      { cls: 'cread', value: costByType.cread, label: `cache read $${costByType.cread.toFixed(2)}` },
    ],
    [costByType],
  );

  const dollars = Math.floor(totals.cost);
  const cents = Math.round((totals.cost - dollars) * 100);

  return (
    <div className="hero">
      <div className="hero-cost">
        <div className="hero-label">Total spent</div>
        <div className="hero-amount">
          <span>${fmtInt(dollars)}</span>
          <span className="cents">.{String(cents).padStart(2, '0')}</span>
        </div>
        <div className="hero-context">
          <strong>{fmtInt(totals.count)}</strong> requests ·{' '}
          <strong>{fmtTokens(totals.total)}</strong> tokens · {contextLine}
        </div>
      </div>

      <div className="hero-decomp">
        <div className="hero-decomp-legend">
          <div className="item input">
            <div className="dot">Input</div>
            <div className="val">{fmtMoney(costByType.input)}</div>
            <div className="sub">{fmtTokens(totals.input)}</div>
          </div>
          <div className="item output">
            <div className="dot">Output</div>
            <div className="val">{fmtMoney(costByType.output)}</div>
            <div className="sub">{fmtTokens(totals.output)}</div>
          </div>
          <div className="item cwrite">
            <div className="dot">Cache·W</div>
            <div className="val">{fmtMoney(costByType.cwrite)}</div>
            <div className="sub">{fmtTokens(totals.cacheWrite)}</div>
          </div>
          <div className="item cread">
            <div className="dot">Cache·R</div>
            <div className="val">{fmtMoney(costByType.cread)}</div>
            <div className="sub">{fmtTokens(totals.cacheRead)}</div>
          </div>
        </div>
        <DecompBar segments={segments} tall />
      </div>
    </div>
  );
}
