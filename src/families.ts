/**
 * Model families — the single source of truth for how raw model strings are
 * grouped into colored buckets across every chart, tag, and decomposition
 * bar (cost-over-time stack + legend, the BY MODEL tag, the per-project
 * "shape" split, the activity heatmap, session tables).
 *
 * Pricing (pricing.ts) is intentionally separate and finer-grained — it
 * distinguishes e.g. gpt-5.5 from gpt-5.5-pro. This layer is coarser: it
 * only assigns each model a *visual* family (a stable color + short label)
 * so stacked charts stay a small, legible palette instead of a rainbow of
 * every individual model id.
 *
 * To support a new vendor/family, add one entry to FAMILIES (and its color
 * vars in styles.css). It then propagates everywhere automatically. Order
 * here = stacking order in charts and order in the legend.
 */

export type FamilyKey = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'other';

export type Family = {
  key: FamilyKey;
  label: string;
  /** CSS reference (a `var(--…)`) holding this family's color. */
  color: string;
  /**
   * Lowercased substrings that identify this family in a model string.
   * First family with a match wins, so order matters for overlaps.
   */
  match: string[];
};

/** Matched families, in stacking/legend order. */
export const FAMILIES: Family[] = [
  { key: 'fable', label: 'Fable', color: 'var(--fable)', match: ['fable', 'mythos'] },
  { key: 'opus', label: 'Opus', color: 'var(--opus)', match: ['opus'] },
  { key: 'sonnet', label: 'Sonnet', color: 'var(--sonnet)', match: ['sonnet'] },
  { key: 'haiku', label: 'Haiku', color: 'var(--haiku)', match: ['haiku'] },
  { key: 'gpt', label: 'GPT', color: 'var(--gpt)', match: ['gpt'] },
];

/** Implicit fallback bucket — anything not matched by FAMILIES lands here. */
export const OTHER: Family = { key: 'other', label: 'Other', color: 'var(--other)', match: [] };

const BY_KEY = new Map<string, Family>(
  [...FAMILIES, OTHER].map((f) => [f.key, f]),
);

/** Classify a raw model string into its visual family. */
export function familyOf(model: string): Family {
  const m = model.toLowerCase();
  for (const f of FAMILIES) {
    for (const s of f.match) {
      if (m.includes(s)) return f;
    }
  }
  return OTHER;
}

/** Look up a family by key; unknown keys fall back to OTHER. */
export function familyByKey(key: string): Family {
  return BY_KEY.get(key) ?? OTHER;
}
