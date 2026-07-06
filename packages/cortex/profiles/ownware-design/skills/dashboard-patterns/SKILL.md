---
name: dashboard-patterns
description: 'Anatomy of an analytics dashboard — KPI tiles, trend cards, data tables, filter bars, drill-down panels. Tile typography (48-64px metric, tabular nums, delta arrow + percent + color). Filter bar position and density. Drill-down composition. Use for any analytics/observability/admin surface with KPIs and tables. Pairs with /report-builder and /data-visualization. Skip for marketing landing pages.'
trigger: /dashboard-patterns
---

# Dashboard Patterns — KPI tile, trend card, table, drill-down

## Overview

Dashboards are the densest UI surface most products ship. The rules that make a marketing page sing (generous whitespace, large hero type, single primary action) actively hurt a dashboard, where the user is scanning seven numbers in three seconds and clicking through to the one that's off. This skill is the four-row anatomy that 90% of analytics surfaces follow, with the typography and density numbers that separate "competent ops tool" from "data-soup admin panel."

Use this when the artifact is an analytics view, observability dashboard, or admin home. Skip when the brief is "marketing page with one chart" — that's a landing page with a visualization, not a dashboard.

---

## Critical Constraints — read these first

1. **Four rows, top to bottom.** (1) Filter bar. (2) Hero KPI row, 3-5 tiles. (3) Trend cards row, 2-3 cards. (4) Detail row — data table + side detail panel. More rows = the page becomes a wall; fewer = it's a glorified report. Four is the sweet spot.
2. **KPI metric: 48-64px, tabular numerals, single line.** Anything below 40px gets lost; anything above 64px competes with section headings. `font-variant-numeric: tabular-nums` is non-negotiable — otherwise digits dance when values change.
3. **Delta = arrow + percent + color, all three.** Never red-green alone (8% of men can't distinguish). `↑ +12.4%` in green AND with the arrow. Down with `↓ -3.1%` in rose AND with the arrow.
4. **Filter bar position: always top, never collapsed by default.** The user lands and immediately needs to see the date range, segment filter, and primary dimension. Hidden filters are the #1 cause of "this dashboard is wrong" support tickets.
5. **Drill-down opens in a SIDE PANEL, not a new page.** Click KPI → side panel slides in showing the rows that compose the metric. Preserving context (the dashboard stays visible behind) is critical for "compare and explain" workflows.
6. **Tabular density: 12-14px row height, 8-12px cell padding, ZEBRA OFF.** Modern dashboards skip zebra stripes; they fight the hairline grid and add visual noise. Use 1px hairline rows on `--cx-border` + sufficient row height (40-48px) instead.

---

## Framework — the four rows

### Row 1 — Filter bar (always)

The control surface for the entire dashboard below. Persistent at the top of the page (not sticky on scroll unless the dashboard is >2 screens tall).

Contents, left to right:
- **Date range picker.** Default to "Last 30 days". Show the active range visibly (e.g. "May 1 - May 30").
- **Comparison toggle.** "Compare to previous period" — toggle ON by default. This drives the delta on every KPI.
- **Primary dimension filter.** The thing the user filters by most often (segment, environment, user cohort, channel). Surfaced as a select or chip group.
- **Secondary filters.** "Filter ▾" dropdown for less-common dimensions. Don't surface 12 filters inline — collapse the long tail.
- **Refresh button + last-updated timestamp.** "Updated 2m ago [↻]". Auto-refresh every 60s or on filter change.

```css
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 32px;
  background: var(--cx-surface);
  border-bottom: 1px solid var(--cx-border);
}
.filter-bar .updated {
  margin-left: auto;
  font-size: 12px;
  color: var(--cx-muted);
}
```

### Row 2 — Hero KPI row (3-5 tiles)

The numbers the user came for. 3 tiles minimum, 5 tiles maximum — past 5, the eye loses the ability to scan them as a row.

Tile composition:
- **Eyebrow label** — 13-14px caps, `letter-spacing: 0.06em`, `color: --cx-muted`. e.g. `MONTHLY ACTIVE USERS`.
- **Metric value** — 48-64px, `font-weight: 600`, `font-variant-numeric: tabular-nums`, `color: --cx-fg-strong`. e.g. `12,847`.
- **Delta vs prior period** — 14px, `↑ +12.4%` in `--cx-good` OR `↓ -3.1%` in `--cx-bad`. Arrow + percent + color, all three.
- **Sparkline** — 60px wide × 24px tall inline SVG, accent-color stroke, no axes. Optional but recommended for KPIs with temporal shape.

```css
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  padding: 24px 32px;
}
.kpi {
  background: var(--cx-surface);
  border-radius: 12px;
  padding: 20px 24px;
  border: 1px solid var(--cx-border);
  cursor: pointer;
  transition: border-color 120ms ease-out;
}
.kpi:hover {
  border-color: var(--cx-accent);
}
.kpi-label {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cx-muted);
  margin: 0 0 8px;
}
.kpi-value {
  font-size: 48px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  color: var(--cx-fg-strong);
  margin: 0;
}
.kpi-delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.kpi-delta.up   { color: var(--cx-good); }
.kpi-delta.down { color: var(--cx-bad); }
```

### Row 3 — Trend cards (2-3 cards)

The temporal shape of the KPIs above. Each card answers "how did this change over the period?" with a line chart.

Card composition:
- **Title** — 16px, `--cx-fg`.
- **Subtitle** — 13px, `--cx-muted`. e.g. "Last 30 days vs. prior 30 days".
- **Chart** — 200-240px tall, full card width. Two series: current period (solid `--cx-accent`) and prior period (dashed `--cx-muted`). See `/data-visualization` for line-chart rules.
- **Optional legend** — bottom-left of card, 12px, muted.

Two cards = side-by-side at 1:1. Three cards = 1:1:1 grid. Don't go past three; the chart shrinks below useful resolution.

### Row 4 — Detail row (table + side panel)

The "drill into the numbers" workspace. Two layouts:

**A. Table-only (full width).** When the user wants to scan a big list. Common for "top N" or "events" views.

**B. Table + side detail panel (60/40 split).** When the user clicks a table row, the panel on the right populates with detail. Best for ops and audit workflows.

Table density:
- Row height: 44-48px (room for icon + text + secondary line)
- Header height: 36px, `--cx-muted` text on `--cx-sunken` background
- Cell padding: 12px horizontal, 8px vertical
- NO zebra striping. Hairline `border-bottom: 1px solid --cx-border` instead.
- Header sticks on scroll: `position: sticky; top: 0;`
- First column carries the primary identifier (name, id, slug). Numeric columns right-align with tabular nums.

---

## KPI tile — the rules nobody gets right

### Delta presentation

Three signals, all required:

| Direction | Arrow | Color | Sign on number |
|-----------|-------|-------|----------------|
| Up (good for revenue, MAU, conversion) | `↑` | `--cx-good` | `+` |
| Down (good for error rate, latency, churn) | `↓` | `--cx-good` | `-` (because "lower is better" — but value is negative delta, so still `-`) |
| Up (bad for error rate, latency) | `↑` | `--cx-bad` | `+` |
| No change | `→` (or omit) | `--cx-muted` | `0%` |

The trap: showing `↑ +5% error rate` in green because "the value went up". Color should reflect SEMANTIC direction (good vs bad), not raw direction. For ambiguous metrics (e.g. average session length), use `--cx-muted` and let the user judge.

### Tabular numerals — mandatory

```css
.kpi-value, .kpi-delta, td.numeric {
  font-variant-numeric: tabular-nums;
}
```

Without this, the digits in `12,847` have different widths than `19,201`, and when the value updates the layout jitters. Tabular nums ship in Inter, IBM Plex Sans, JetBrains Mono, Geist, all the dashboard staples.

### KPI hover state

The tile is clickable (opens drill-down). Make it obvious:
- Border color shifts to `--cx-accent` on hover.
- Cursor `pointer`.
- Optional: a `chevron-right` icon appears in the top-right corner on hover (reveals the affordance).

---

## Drill-down side panel

When a user clicks a KPI tile or a chart point, slide in a panel from the right (380-440px wide). The dashboard stays visible behind, slightly dimmed.

Panel composition:
- **Header** — Metric name + close button (`x` icon, top-right).
- **Hero number** — Repeat the KPI value at 32px so the user has anchor.
- **Composition** — A small table or list showing the items that compose the metric (e.g. for "MAU = 12,847", show the top 10 cohorts and their counts).
- **Action footer** — "Export CSV", "View full report" links.

```css
.drill-panel {
  position: fixed;
  top: 0; right: 0;
  height: 100vh;
  width: 420px;
  background: var(--cx-elevated);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.12);
  transform: translateX(100%);
  transition: transform 220ms cubic-bezier(0.23, 1, 0.32, 1);
  z-index: 400;
}
.drill-panel.is-open {
  transform: translateX(0);
}
.drill-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.12);
  z-index: 300;
}
```

Open with `transform`, not `width`. Width animation forces layout recalc on every frame.

---

## Concrete examples

### Example 1 — 4-row analytics dashboard layout (anatomy of a real surface)

```html
<main class="dashboard" data-cx-id="analytics-dashboard">

  <!-- Row 1: Filter bar -->
  <header class="filter-bar" data-cx-id="filter-bar">
    <button class="date-picker">May 1 - May 30, 2026 ▾</button>
    <label class="compare-toggle">
      <input type="checkbox" checked />
      Compare to prior 30 days
    </label>
    <select class="segment-filter">
      <option>All segments</option>
      <option>Enterprise</option>
      <option>SMB</option>
    </select>
    <button class="more-filters">Filters ▾</button>
    <span class="updated">Updated 2m ago <button class="refresh">↻</button></span>
  </header>

  <!-- Row 2: KPI tiles (4 tiles) -->
  <section class="kpi-row" data-cx-id="kpi-row">
    <article class="kpi">
      <p class="kpi-label">Monthly active users</p>
      <p class="kpi-value">12,847</p>
      <p class="kpi-delta up">↑ +12.4% vs. prior 30d</p>
    </article>
    <article class="kpi">
      <p class="kpi-label">Revenue</p>
      <p class="kpi-value">$284,210</p>
      <p class="kpi-delta up">↑ +8.7% vs. prior 30d</p>
    </article>
    <article class="kpi">
      <p class="kpi-label">Conversion rate</p>
      <p class="kpi-value">4.2%</p>
      <p class="kpi-delta down">↓ -0.3pp vs. prior 30d</p>
    </article>
    <article class="kpi">
      <p class="kpi-label">P95 latency</p>
      <p class="kpi-value">218ms</p>
      <p class="kpi-delta up">↑ +24ms vs. prior 30d</p>
    </article>
  </section>

  <!-- Row 3: Trend cards (2 cards) -->
  <section class="trend-row" data-cx-id="trend-row">
    <article class="trend-card">
      <h3>MAU over time</h3>
      <p class="trend-sub">Last 30 days vs prior period</p>
      <svg class="trend-chart" viewBox="0 0 600 200"><!-- two polylines --></svg>
    </article>
    <article class="trend-card">
      <h3>Revenue by day</h3>
      <p class="trend-sub">Last 30 days vs prior period</p>
      <svg class="trend-chart" viewBox="0 0 600 200"><!-- two polylines --></svg>
    </article>
  </section>

  <!-- Row 4: Table + drill panel (table-only state shown) -->
  <section class="detail-row" data-cx-id="detail-row">
    <table class="data-table">
      <thead>
        <tr>
          <th>Customer</th>
          <th>Plan</th>
          <th class="numeric">MAU</th>
          <th class="numeric">Revenue</th>
          <th class="numeric">Last seen</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>Acme Corp</td><td>Enterprise</td><td class="numeric">3,210</td><td class="numeric">$48,200</td><td class="numeric">2h ago</td></tr>
        <tr><td>Globex</td><td>Pro</td><td class="numeric">1,847</td><td class="numeric">$22,100</td><td class="numeric">14m ago</td></tr>
        <!-- ...20 more rows -->
      </tbody>
    </table>
  </section>

</main>
```

Notice what's absent: no decorative illustrations, no marketing copy, no whitespace-rich hero. A dashboard is a control surface; ornament is the enemy.

### Example 2 — KPI tile alone, with hover and click affordances

```html
<button class="kpi" type="button">
  <div class="kpi-head">
    <p class="kpi-label">Revenue</p>
    <svg class="kpi-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="9,6 15,12 9,18" fill="none" stroke="currentColor" stroke-width="2"/>
    </svg>
  </div>
  <p class="kpi-value">$284,210</p>
  <div class="kpi-foot">
    <span class="kpi-delta up">↑ +8.7%</span>
    <span class="kpi-period">vs. prior 30d</span>
  </div>
  <svg class="kpi-spark" viewBox="0 0 60 24" aria-hidden="true">
    <polyline fill="none" stroke="var(--cx-accent)" stroke-width="1.5"
              points="0,18 8,16 16,14 24,15 32,10 40,8 48,6 56,4 60,3"/>
  </svg>
</button>

<style>
.kpi {
  display: block;
  text-align: left;
  width: 100%;
  background: var(--cx-surface);
  border: 1px solid var(--cx-border);
  border-radius: 12px;
  padding: 20px 24px;
  cursor: pointer;
  transition: border-color 120ms ease-out, transform 120ms ease-out;
}
.kpi:hover { border-color: var(--cx-accent); }
.kpi:focus-visible {
  outline: 2px solid var(--cx-accent);
  outline-offset: 2px;
}
.kpi-head { display: flex; align-items: center; justify-content: space-between; }
.kpi-chevron { width: 16px; height: 16px; color: var(--cx-muted); opacity: 0; transition: opacity 120ms; }
.kpi:hover .kpi-chevron { opacity: 1; }
.kpi-label {
  font-size: 13px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--cx-muted); margin: 0;
}
.kpi-value {
  font-size: 48px; font-weight: 600; line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--cx-fg-strong); margin: 8px 0 4px;
}
.kpi-foot { display: flex; gap: 8px; align-items: baseline; }
.kpi-delta { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; }
.kpi-delta.up { color: var(--cx-good); }
.kpi-delta.down { color: var(--cx-bad); }
.kpi-period { font-size: 13px; color: var(--cx-muted); }
.kpi-spark { width: 100%; height: 24px; margin-top: 8px; }
</style>
```

Reads as a tile. Behaves as a button. Click drives a drill-panel open with the revenue composition.

---

## Anti-patterns

- **Six or more KPI tiles in the hero row.** Eye loses scan ability. Three to five.
- **KPI value under 40px.** Reads as body text, not as a metric. 48-64px is the floor.
- **`font-variant-numeric: normal` on KPI values.** Numbers jitter when they update. Always `tabular-nums`.
- **Red-green delta with no arrow.** 8% of men can't reliably distinguish. Pair color WITH `↑`/`↓` arrow WITH `+`/`-` sign.
- **Color reflecting raw direction, not semantic.** `↑ +5% error rate` in GREEN because the number went up. Wrong. Up-error-rate is BAD. Color by meaning.
- **Filters collapsed by default.** Users land confused. Surface the 3 most-used filters inline; collapse only the long tail.
- **Zebra-striped tables.** Visual noise. Hairline rows + sufficient row height are better.
- **Drill-down opens in a new page.** Loses context. Side panel preserves the dashboard behind for compare-and-explain.
- **Marketing-page section padding (96px) inside a dashboard.** Dashboards are dense by design. Use 16-32px section padding.
- **Decorative hero illustration above the KPI row.** No. A dashboard is a control surface; ornament costs density.
- **Sparklines with axes.** Defeats the purpose. Sparklines are the SHAPE, not the data.
