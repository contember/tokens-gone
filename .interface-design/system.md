# tokens-gone — interface design system

## Intent

**Who.** A developer reviewing their own Claude Code spend. Casual / introspective use, not mission-critical finance. Comes here to investigate: "where did the money go," "which session ran away," "is Opus worth it for what I'm doing."

**Verb.** Investigate. Scanning, comparing, looking for stories in their own usage.

**Feel.** Ledger meets log reader. Append-only event streams with cost attached. Warm, observable, slightly nerdy — *not* corporate finance dashboard, *not* consumer fitness app. Closer to reading an itemized phone bill on a quiet evening.

## Direction

**Off-black canvas, warm hue** — not slate. The product is about Claude, so the palette borrows from Anthropic's warm brand world (terracotta, peach, cream) rather than the cold-blue defaults of dev tooling. This is a deliberate differentiator: most dev dashboards are cold-slate, this one is warm.

**Single accent: terracotta** (`#e07856`). Interactive state only — active filter, focus ring, hover affordance. Never decorative.

**Model hues — only in stacked visualizations** (heatmap, chart, decomp bars):
- Opus: burnished amber (`#d4a574`)
- Sonnet: warm peach (`#c87f5a`)
- Haiku: mossy green (`#94a172`)

**Token-type hues** (decomposition segments):
- Input: moss; Output: amber; Cache write: peach; Cache read: cool blue (the one cool color — cache reads are quietly the dominant cost component, this lets them visually anchor the bar).

## Signature element

**Decomposition bar.** Horizontal stacked strip showing what *kind* of usage drives a number. Used at three scales:

1. **Hero**: full-width tall bar (10px) under the total cost, split by token type, with dollar amounts above each segment.
2. **By-model rows**: compact bar (6px) in each row, split by token type — every model has a distinct *shape* (Opus = blue-heavy / cache reads, Haiku = peach-heavy / cache writes).
3. **By-project rows**: compact bar (6px), but split by *model family* — answers "which models does this project use?"

The bar is what makes one cost number tell a story. A single $1,121 is opaque; the same number with a shape is readable instantly.

**Secondary signature: GitHub-style activity heatmap** for the past year. Color buckets derived from data quantiles (p20/p50/p80/p95) so it adapts to both heavy and light users. Click toggles a single-day filter.

## Defaults rejected

| Default | Replaced with |
|---|---|
| 8-card KPI grid at top | Single hero stat (`$10,687.85` large mono) + decomposition strip on the right |
| Date preset button toolbar | Breadcrumb-style filter chips ("All time › Opus 4.7 › webmaster"), date selection in a popover from the range chip |
| Filter chips section | Inline breadcrumbs above hero + `+ model` / `+ project` searchable popover dropdowns |
| Cost-only table columns | Rows with decomposition mini-bar + background fill = % of grand total |

## Depth

**Borders only.** This is a dense data tool — no shadows, no card surfaces. Borders at 0.04 / 0.07 / 0.14 opacity define section structure without demanding attention. The one exception: tooltip elements get a shadow + slightly elevated background since they float over content.

Surface elevation is essentially flat — `--ink-0` for canvas, `--ink-1`/`--ink-2` only for popovers, dropdowns, and tooltips.

## Typography

System fonts only — **no Google Fonts, no bundled fonts** (zero outgoing requests is a hard constraint).
- Sans: `ui-sans-serif, system-ui, ...`
- Mono: `ui-monospace, "SF Mono", "JetBrains Mono", ...`

**Numbers are always mono.** `font-variant-numeric: tabular-nums` everywhere a column of figures appears (KPIs, table cells, axis labels, tooltips). The mono gives the interface its "instrument readout" feel and keeps columns of numbers visually scannable.

**Hero amount**: 56px mono, weight 400, letter-spacing `-0.04em`. The tight tracking + large mono reads as "printed receipt total," not "marketing hero." Cents (`.85`) are de-emphasized in muted color at 55% size.

**Section headings**: 11px uppercase, letter-spacing 0.08em, in tertiary text color. They recede so the data leads.

## Tokens

```
--ink-0  #0c0b0a   canvas (warm off-black)
--ink-1  #131110   popover / dropdown surface
--ink-2  #1a1816   tooltip / hover surface

--line         rgba(244,235,220, .07)   default border
--line-soft    rgba(244,235,220, .04)   section dividers
--line-strong  rgba(244,235,220, .14)   focus / popover edge

--t-1     #f1e8d8   primary text (warm cream)
--t-2     #b5a994   secondary
--t-3     #7a6f5e   tertiary (labels, meta)
--t-mute  #4a4339   disabled / placeholder

--accent       #e07856                       terracotta — single interactive color
--accent-soft  rgba(224,120,86, .13)         selected-row background
--accent-line  rgba(224,120,86, .4)          active border / focus ring
```

## Spacing & radius

4px base. Scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Sections separated by 32 (`--s-6`).

Radius: small and technical. 3px on inputs/chips, 5px on popovers, 8px on cards (rarely used since we're borders-only).

## Component patterns

**`<DecompBar />`** in `src/components/DecompBar.tsx` — used wherever a number has a shape. Takes `Segment[]` and renders a flex strip with `min-width: 1px` segments so even small slices remain visible.

**`<ActiveFilters />`** — breadcrumb-style filters with `›` separators. Each filter is a clickable chip with an `×`. Adding filters happens via two popover triggers (`+ model`, `+ project`) that share `<MultiSelect />` with searchable options. Date range gets its own popover with preset shortcuts.

**Table rows with `<div className="row-bar bg-only">`** — absolutely-positioned gradient inside the first cell, width = % of grand total. Provides quick "magnitude scan" without a separate sparkline column.

**`<ActivityHeatmap />`** — 53-week × 7-day grid with quantile-based color bucketing. Days are calendar-stepped (not `+86400000`) to handle DST correctly. Click toggles `from`/`to` to that day's bounds.

**`<HourGrid />`** — 7-day × 24-hour matrix using the same heatmap color scale. Reveals work rhythm.

## Constraints to remember

- **Zero outgoing requests**: no CDN fonts, no LiteLLM fetch, no analytics.
- **System fonts only**: design must work with whatever ships on the user's OS.
- **Mono for numbers, sans for labels**: never mix.
- **Single accent**: if you reach for a second accent color, you're decorating, not communicating. Find the meaning first.
