/**
 * Decomposition bar — the product's signature element. A horizontal bar
 * split into segments by token type (or model), each sized by its
 * proportion. Used in the hero (large) and in every table row (compact).
 *
 * Why: a single cost number tells you HOW MUCH, but not WHAT KIND. Most
 * spend on Claude Code is cache reads — that fact is invisible in a $
 * column but pops out instantly in the bar. Per-row bars make the *shape*
 * of each model/project's usage scannable in one glance.
 */

import type { FamilyKey } from '../families';

export type Segment = {
  cls: 'input' | 'output' | 'cwrite' | 'cread' | FamilyKey;
  value: number;
  label?: string;
};

export function DecompBar({
  segments,
  tall = false,
  title,
  width,
}: {
  segments: Segment[];
  tall?: boolean;
  title?: string;
  /**
   * Fraction (0..1) of the available width the bar should occupy. Lets a
   * row's bar length encode its magnitude relative to its peers. Omit for a
   * full-width bar (the hero).
   */
  width?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const style = width != null ? { width: `${Math.max(width, 0) * 100}%` } : undefined;
  if (total <= 0) return <div className={`decomp${tall ? ' tall' : ''}`} style={style} />;
  return (
    <div className={`decomp${tall ? ' tall' : ''}`} title={title} style={style}>
      {segments.map((s, i) => (
        <div
          key={i}
          className={`seg ${s.cls}`}
          style={{ width: `${(s.value / total) * 100}%` }}
          title={s.label}
        />
      ))}
    </div>
  );
}
