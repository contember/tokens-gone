import { useEffect, useMemo, useRef, useState } from 'react';
import type { Totals } from '../aggregate';
import { fmtInt, fmtMoney, fmtTokens } from '../format';
import { DecompBar, type Segment } from './DecompBar';

/**
 * Hero stat: huge cost number + a 4-segment decomposition bar showing
 * where the money actually went (input / output / cache write / cache read).
 * The bar repeats in tables — once you internalize the colors, every row
 * becomes readable at a glance.
 *
 * In `live` mode the headline numbers extrapolate beyond the latest
 * fetched totals using the burn rate observed across the last two
 * fetches — gives the "watch dollars tick up" effect.
 */
export function Hero({
  totals,
  costByType,
  contextLine,
  live,
}: {
  totals: Totals;
  costByType: { input: number; output: number; cwrite: number; cread: number };
  contextLine: string;
  live: boolean;
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

  const liveCost = useExtrapolated(totals.cost, live);
  const liveCount = useExtrapolated(totals.count, live);
  const liveTotal = useExtrapolated(totals.total, live);
  const burnRate = useBurnRate(totals.cost, live);

  const dollars = Math.floor(liveCost);
  // Tick the cents digit at ~10Hz when live so the eye sees motion even
  // when the burn rate is sub-dollar/sec. The .toFixed(2) below already
  // gives us cents granularity; we just need to re-render fast enough.
  const cents = Math.round((liveCost - dollars) * 100);

  return (
    <div className="hero">
      <div className="hero-cost">
        <div className="hero-label">
          Total spent
          {live && (
            <span className="hero-live-tag" title="Live mode — extrapolating from last 5s">
              <span className="live-dot" aria-hidden />
              live · ${burnRate.toFixed(burnRate >= 1 ? 2 : 4)}/s
            </span>
          )}
        </div>
        <div className="hero-amount">
          <span>${fmtInt(dollars)}</span>
          <span className="cents">.{String(cents).padStart(2, '0')}</span>
        </div>
        <div className="hero-context">
          <strong>{fmtInt(Math.floor(liveCount))}</strong> requests ·{' '}
          <strong>{fmtTokens(liveTotal)}</strong> tokens · {contextLine}
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

// Number of fetch intervals to average the burn rate over. Three windows
// (≈15s at the default 5s tick) smooths out the lumpiness of streaming
// chunks landing in one tick vs another, without lagging so far behind
// that bursts of activity stop being visible.
const RATE_WINDOW_PERIODS = 3;
const RATE_WINDOW_SAMPLES = RATE_WINDOW_PERIODS + 1;

/** Average rate (value-per-ms) across the retained sample window. */
function windowedRate(samples: { value: number; t: number }[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  // Clamp non-negative: entries only grow, so a negative delta means
  // filters changed underneath us or the server reset — never rewind.
  return Math.max(0, (last.value - first.value) / dt);
}

/**
 * Forward-extrapolate a target value beyond its last update using the
 * burn rate averaged across the last `RATE_WINDOW_PERIODS` fetch
 * intervals. Strictly monotonic — if a new target arrives lower than
 * the current display the display pauses at its current value until the
 * actual catches back up.
 *
 * When `enabled` is false the display snaps to `target` and stays there;
 * we deliberately preserve no animation state so toggling live mode off
 * gives an instant "back to ground truth" feel.
 */
function useExtrapolated(target: number, enabled: boolean): number {
  const [display, setDisplay] = useState(target);
  const samplesRef = useRef<{ value: number; t: number }[]>([]);

  // Record a sample every time the target changes.
  useEffect(() => {
    samplesRef.current.push({ value: target, t: performance.now() });
    while (samplesRef.current.length > RATE_WINDOW_SAMPLES) {
      samplesRef.current.shift();
    }
  }, [target]);

  useEffect(() => {
    if (!enabled) {
      setDisplay(target);
      samplesRef.current = [{ value: target, t: performance.now() }];
      return;
    }

    let raf = 0;
    let running = true;
    function tick() {
      if (!running) return;
      const samples = samplesRef.current;
      if (samples.length >= 2) {
        const last = samples[samples.length - 1]!;
        const rate = windowedRate(samples);
        const elapsed = performance.now() - last.t;
        const projected = last.value + rate * elapsed;
        setDisplay((cur) => Math.max(cur, projected, last.value));
      } else if (samples.length === 1) {
        setDisplay(samples[0]!.value);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [enabled, target]);

  return display;
}

function useBurnRate(target: number, enabled: boolean): number {
  const samplesRef = useRef<{ value: number; t: number }[]>([]);
  const [rate, setRate] = useState(0);

  useEffect(() => {
    samplesRef.current.push({ value: target, t: performance.now() });
    while (samplesRef.current.length > RATE_WINDOW_SAMPLES) {
      samplesRef.current.shift();
    }
    // windowedRate returns value-per-ms; surface value-per-second.
    setRate(windowedRate(samplesRef.current) * 1000);
  }, [target]);

  useEffect(() => {
    if (!enabled) {
      setRate(0);
      samplesRef.current = [];
    }
  }, [enabled]);

  return rate;
}
