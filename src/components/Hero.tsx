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
// Cap how far past the latest sample we project. With a 5s polling
// interval and 1.2x safety margin this keeps overshoot bounded even if
// the next fetch is briefly late, but stops display from drifting wildly
// when polling stalls.
const MAX_LOOKAHEAD_MS = 6000;

type Sample = { value: number; t: number };

/** Average rate (value-per-ms) across the retained sample window. */
function windowedRate(samples: Sample[]): number {
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
 * Maintain a rolling sample buffer that is *cleared* every time `enabled`
 * flips from false to true. Without this, the first computed rate after
 * re-enabling would include a stale sample from the previous live
 * session (possibly minutes old), squashing the rate to near-zero and
 * stalling the display. Returns the array; consumers can read `.length`
 * and indices, and the reference is stable while live is enabled.
 */
function useRollingSamples(target: number, enabled: boolean): Sample[] {
  const samplesRef = useRef<Sample[]>([]);
  const prevEnabledRef = useRef(false);

  // Synchronous reset on enable transitions, so the very next render
  // (and the raf loop that consumes the ref) sees the fresh buffer.
  if (!enabled) {
    if (prevEnabledRef.current) samplesRef.current = [];
    prevEnabledRef.current = false;
  } else if (!prevEnabledRef.current) {
    samplesRef.current = [{ value: target, t: performance.now() }];
    prevEnabledRef.current = true;
  }

  useEffect(() => {
    if (!enabled) return;
    const last = samplesRef.current[samplesRef.current.length - 1];
    // First sample after enable was seeded synchronously above; skip
    // pushing a duplicate when the post-enable render commits.
    if (last && last.value === target) return;
    samplesRef.current.push({ value: target, t: performance.now() });
    while (samplesRef.current.length > RATE_WINDOW_SAMPLES) {
      samplesRef.current.shift();
    }
  }, [target, enabled]);

  return samplesRef.current;
}

/**
 * Forward-project `target` past its last fetch using the windowed burn
 * rate. `display = last.value + rate × min(elapsed, MAX_LOOKAHEAD_MS)`
 * recomputed every animation frame.
 *
 * No monotonic Math.max guard. When a new fetch comes in with a lower
 * rolling rate the display tracks the new projection — a tiny visible
 * correction is fine; the alternative is freezing for tens of seconds
 * when an earlier high-rate window has overshot reality. The lookahead
 * cap keeps the bias to fractions of one window worth of burn.
 *
 * When `enabled` is false the consumer just gets `target` straight; we
 * don't try to interpolate at all.
 */
function useExtrapolated(target: number, enabled: boolean): number {
  const samples = useRollingSamples(target, enabled);
  const [extrapolated, setExtrapolated] = useState(target);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let running = true;
    function tick() {
      if (!running) return;
      if (samples.length >= 2) {
        const last = samples[samples.length - 1]!;
        const rate = windowedRate(samples);
        const elapsed = Math.min(performance.now() - last.t, MAX_LOOKAHEAD_MS);
        setExtrapolated(last.value + rate * elapsed);
      } else if (samples.length === 1) {
        setExtrapolated(samples[0]!.value);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [enabled, samples]);

  return enabled ? extrapolated : target;
}

function useBurnRate(target: number, enabled: boolean): number {
  const samples = useRollingSamples(target, enabled);
  // windowedRate is value-per-ms; surface as value-per-second.
  return enabled ? windowedRate(samples) * 1000 : 0;
}
