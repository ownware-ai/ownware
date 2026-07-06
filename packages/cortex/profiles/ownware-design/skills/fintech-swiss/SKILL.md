---
name: fintech-swiss
description: 'Fintech sub-variant of swiss-international-deck — same grid + sans + single accent, but tuned for financial data. Tabular numerals everywhere, inline micro-charts beside metrics, restrained palette (greys + ONE trust blue or green), data tables dominant, no simultaneous red-and-green deltas per color-blindness rules. Use for investor updates, board reviews, P&L slides. Skip for consumer fintech marketing (use deck + Warm Soft).'
trigger: /fintech-swiss
---

# Fintech Swiss — Swiss discipline, tuned for financial data

## Overview

A variant of `/swiss-international-deck` for slides where the data *is* the message. Investor updates, board reviews, treasury reports, P&L breakdowns, MRR cohort tables. The grid, the sans-only typography, the corner chrome, the `border-radius: 0` discipline — all carry over. The differences are about *how data renders*: tabular numerals everywhere, micro-charts inline with metrics, palette compressed to greys + one trust color, and (load-bearing) no simultaneous green-and-red as the only signal of up/down.

If you haven't already, read `/swiss-international-deck` — this skill is its sibling, not a replacement. Skip this skill for warm consumer fintech marketing decks (Wealthfront / Mint style) — that's `/deck` + Warm Soft direction. Use this when the audience is a CFO, a board, an LP, an auditor.

---

## Critical Constraints — read these first, every time

1. **Tabular numerals are non-negotiable.** Every digit on every slide aligns vertically. Use JetBrains Mono for numerics, or Inter with `font-variant-numeric: tabular-nums`. Proportional digits in a P&L table look amateur and obscure the data.
2. **One trust color, not two.** Pick blue (`#1F4FD1`) for traditional finance / institutional audiences, or green (`#0F7A4A`) for sustainability / impact / banking. Never mix; never add a second accent for "balance."
3. **No simultaneous red-and-green deltas.** ~5% of male viewers (and a non-trivial share of any boardroom) are red-green color-blind. A `+12%` in green and `-8%` in red is illegible to them. Use shape OR position OR a single hue gradient (light-grey → ink) AND mandatory `+ / −` glyphs or arrows. See "Color-blind delta rule" below.
4. **Data tables are the dominant element.** A fintech deck without at least one full data table is incomplete. Tables get the slide; everything else is supporting chrome.
5. **Micro-charts inline with metrics, not as separate slides.** A 200×40px sparkline next to a KPI value tells more than a full-slide bar chart. Sparklines render as inline SVG.
6. **Precision in every number.** `$4.2M` and `$4,231,847` are different decks. Match the precision to the audience — board sees `$4.2M`, finance committee sees `$4,231,847`. Don't show both on the same slide.
7. **Hairline rules between rows, never alternating row fills.** "Zebra striping" is for HR dashboards; fintech is hairlines. A data table is a 1px ink rule above the header and one between each row. Nothing else.
8. **Every chart axis labeled with units.** "Revenue" alone is not a label. "Revenue (USD, monthly)" is.

---

## Visual language

### Palette — greys + one trust color

```css
:root {
  --ink:       #0a0a0a;
  --paper:     #fafaf8;
  --grey-900:  #1a1a1a;
  --grey-700:  #4a4a4a;
  --grey-500:  #7a7a7a;
  --grey-300:  #c4c4c4;
  --grey-100:  #e8e8e8;
  --rule:      #1a1a1a;       /* 1px hairlines */
  --paper-2:   #f3f1ec;       /* secondary background for hero numerics */

  /* Pick ONE — never both */
  --accent:    #1F4FD1;       /* Trust Blue — institutional / traditional */
  /* --accent: #0F7A4A;        Trust Green — sustainability / impact */

  /* Deltas: hue stays neutral; shape carries the sign */
  --delta-up:   #0a0a0a;      /* black — up arrow does the work */
  --delta-down: #6a6a6a;      /* mid-grey — down arrow does the work */

  --font-display: "Inter Tight", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-body:    "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-mono:    "JetBrains Mono", ui-monospace, monospace;
}
```

Critical: **never** add a `--bad: red` token to a fintech-swiss deck. The next agent to touch the file will reach for it; the audience will lose half its information.

### Tabular numerals — the rule

Every numeric run on the slide uses one of:

```css
.numeric  { font-family: var(--font-mono); font-feature-settings: "tnum" 1; }
.numeric-inter { font-family: var(--font-body); font-variant-numeric: tabular-nums; }
```

JetBrains Mono is tabular by default. Inter needs the `tabular-nums` declaration; without it, the `1` is narrower than the `8` and your P&L looks crooked.

### Data table — the workhorse pattern

```html
<table class="ledger">
  <thead>
    <tr><th>Segment</th><th>Q2</th><th>Q3</th><th>Δ</th><th>Trend</th></tr>
  </thead>
  <tbody>
    <tr><td>North America</td>     <td>$4.20M</td><td>$5.16M</td><td>↑ 23%</td><td><svg class="spark">…</svg></td></tr>
    <tr><td>Europe</td>            <td>$2.10M</td><td>$2.84M</td><td>↑ 35%</td><td><svg class="spark">…</svg></td></tr>
    <tr><td>Asia-Pacific</td>      <td>$0.88M</td><td>$1.42M</td><td>↑ 61%</td><td><svg class="spark">…</svg></td></tr>
    <tr><td>Latin America</td>     <td>$0.32M</td><td>$0.29M</td><td>↓  9%</td><td><svg class="spark">…</svg></td></tr>
  </tbody>
</table>

<style>
  .ledger { width: 100%; border-collapse: collapse; font: 16px/1.5 var(--font-body); }
  .ledger th, .ledger td { padding: 14px 16px; text-align: left;
                            border-top: 1px solid var(--rule); }
  .ledger thead th { font: 600 11px/1 var(--font-mono);
                      letter-spacing: 0.12em; text-transform: uppercase;
                      color: var(--grey-700); padding-bottom: 18px; border-top: none; }
  .ledger thead { border-bottom: 1px solid var(--rule); }
  .ledger td:nth-child(n+2) { font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; }
  .ledger td:nth-child(4) { color: var(--ink); font-weight: 600; }
  .spark { width: 120px; height: 32px; vertical-align: middle; }
</style>
```

Header row: 11px uppercase mono with `letter-spacing: 0.12em`. Body: 16px Inter for the label column, JetBrains Mono right-aligned for numeric columns. Δ column shows arrow + percentage; trend column holds a 120×32 sparkline.

### Sparkline — inline SVG, no library

```html
<svg class="spark" viewBox="0 0 120 32" preserveAspectRatio="none">
  <polyline fill="none" stroke="var(--accent)" stroke-width="1.5"
            points="0,28 20,24 40,22 60,16 80,12 100,8 120,4" />
  <circle cx="120" cy="4" r="2.2" fill="var(--accent)" />
</svg>
```

Trust color line, 1.5px stroke, terminal dot. Points are computed from the data; never decorative.

---

## Color-blind delta rule — the load-bearing detail

Up/down deltas must be readable without color. Three acceptable patterns:

1. **Arrows + percent, single hue.** `↑ 23%` in `--ink`; `↓ 9%` in `--grey-500`. The arrow carries the sign; the percentage carries the magnitude. This is the default.
2. **Sign glyph + value, single hue.** `+23%` / `−9%` with the same color treatment. Use the proper minus glyph (`−`, U+2212), not a hyphen.
3. **Bar fill from a midline, single hue.** A horizontal bar growing left or right from a center axis, all in the accent color. Direction carries the sign; length carries the magnitude.

**Forbidden:**

- `↑ 23%` in green and `↓ 9%` in red as the only signal.
- A "deltas heat-map" coloring cells by signed value with no glyph.
- "Red bad / green good" anywhere.

The acid test: print the slide in grayscale (or pick "View > Reader Mode" in Chrome). If a CFO with deuteranopia could still tell the segments apart and identify the laggards, the slide passes.

---

## Slide patterns specific to fintech-swiss

Pattern A (Cover), B (Statement), F (Closing) carry over from `/swiss-international-deck` unchanged. The five fintech-specific patterns are:

### F-1 — Ledger table (the workhorse)

Full-bleed data table as the slide's primary element. 12-column grid; table spans 12. Headline is a single line above the table at 32px. Footnotes below at 13px muted. See the markup in the previous section.

### F-2 — KPI row with sparklines

Four KPIs across; each KPI has the current value (96px mono), the delta (arrow + percent, 24px mono), and a 200×48 sparkline.

```html
<div class="kpi-row">
  <div class="kpi">
    <div class="t-kicker">ARR</div>
    <div class="kpi-value">$42.1M</div>
    <div class="kpi-delta">↑ 18%</div>
    <svg class="kpi-spark" viewBox="0 0 200 48">…</svg>
  </div>
  <!-- × 4 -->
</div>
```

### F-3 — Two-axis chart with annotation

One chart, two y-axes (e.g. MRR on left, churn rate on right). Annotation callouts at specific x positions explaining notable points ("Pricing change shipped" / "New cohort acquisition channel"). Annotation is a 1px hairline pointing at the data point, with caption text in 13px muted.

### F-4 — Waterfall

Stepped bars showing how an opening balance becomes a closing balance through positive and negative contributions. Each bar is the trust color; sign is conveyed by direction (up bars sit on top of the running total, down bars sit below). Connector lines are 1px ink hairlines.

### F-5 — Cohort grid

Rows = cohort start month, columns = months since acquisition, cell values = retention percentage. Cells colored by single-hue intensity (grey-100 → accent at full saturation). Number always visible in the cell — color is supplemental, not primary.

---

## Concrete examples

### Example 1 — four-slide investor update

Brief: quarterly LP letter companion, Trust Blue palette, audience is institutional limited partners.

1. **S01 Cover** — Pattern A from `/swiss-international-deck`. "Q3 2026 · Operating Review · Acme Inc."
2. **S02 Top-line KPIs** — Pattern F-2. Four KPIs: `ARR $42.1M ↑ 18%`, `Gross margin 78% ↑ 3pt`, `Burn $2.4M ↓ 22%`, `Runway 27mo ↑ 6mo`. Each with a 12-month sparkline.
3. **S03 Revenue ledger** — Pattern F-1. Five-row table: North America / Europe / Asia-Pacific / Latin America / Middle East. Columns: Segment / Q2 / Q3 / Δ / Trend (sparkline). All numerics tabular; deltas as arrows + percent, single hue.
4. **S04 Forward ask** — Pattern F from `/swiss-international-deck`. Left half Trust Blue accent: "Approve the 2027 budget envelope." Right half three line items with 1px hairlines and tabular numerics.

Chrome on every slide: `Q3 2026 · INVESTOR REVIEW` top-left, `Acme Inc.` top-right, `№N / 4` bottom-left, `Confidential · 2026-11-14` bottom-right.

### Example 2 — Trust Green variant for an impact fund's annual report

Same patterns; swap `--accent: #0F7A4A`. The acid test is identical — print to grayscale, deltas still readable. Cohort grids (Pattern F-5) use the green at varying intensity for retention; no red anywhere in the deck.

### Example 3 — wrong move flagged

User asks for a fintech-swiss deck with "Red for revenue down, green for revenue up. It's what the board is used to." Push back. The discipline is non-negotiable for accessibility, and the board's habit is not an excuse for losing the deuteranopic audience. Offer the alternative: arrows + percent in single hue, optionally add a small `±` glyph in a second weight if the board needs more emphasis. Get user agreement before shipping.

---

## Anti-patterns

- **Adding red as a `--bad` token.** Stop. The whole skill exists to avoid the red-green trap. The next agent will reach for `--bad` and you've reintroduced the bug.
- **Proportional digits in a P&L.** Stop. JetBrains Mono for every numeric run, or Inter with `font-variant-numeric: tabular-nums`. Misaligned digits are a fintech tell.
- **Zebra-striped tables.** Stop. Hairlines, not alternating fills. Zebra is HR dashboard / consumer admin language.
- **Sparklines via a charting library.** Stop. Inline SVG `<polyline>` with computed points. 8 lines of markup; no dependency.
- **Charts without unit labels.** Stop. "Revenue" alone is not a label. "Revenue (USD, monthly, GAAP)" is. The CFO will ask; pre-empt them.
- **Two accent colors / second trust color.** Stop. One. The whole system depends on the monochrome-plus-one tension; a second hue collapses it.
- **Cell color as the only delta signal in a cohort grid.** Stop. Number always visible, color supplemental. Print-to-grayscale test must pass.
- **Using this style for a warm consumer fintech marketing deck.** Stop. Wrong tool. Reach for `/deck` + Warm Soft. This style is for boardrooms, not landing pages.
