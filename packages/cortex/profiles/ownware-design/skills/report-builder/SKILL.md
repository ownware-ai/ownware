---
name: report-builder
description: Turn a CSV/JSON dataset + a brief into a single self-contained HTML dashboard via writeFile. Output is one HTML file with 3-5 KPI tiles, 2-3 Chart.js charts (CDN), and a raw-data table. Use when the user supplies real data and wants a visual report — weekly metrics, cohorts, finance dashboards. Do NOT use for live-querying dashboards or general exploration — that's `data-visualization`. Do NOT use for charts in a deck — that's `deck` with inline SVG.
trigger: /report-builder
---

# Report Builder — data → single-file HTML dashboard

## Overview

Input: a CSV / JSON dataset (pasted or referenced) plus a brief ("weekly revenue + cohort retention, hero on top, monthly rollup table at the bottom"). Output: ONE self-contained `index.html` the user can open locally, screenshot, or attach to a Notion doc. No build step, no external data file, no server.

Charts use **Chart.js via jsDelivr CDN** — pinned, predictable, well-documented. Never d3 (too low-level for this skill's scope), never ECharts (heavier surface). One charting library, consistent across every report.

Same file-shape rules as the `artifact` skill: one file, `:root` tokens at top, `data-cx-id` on every region. The difference is content — KPI tiles + charts + table, in that order, every time.

---

## Critical Constraints — read these first

1. **One HTML file.** `index.html`. Inline `<style>`, inline `<script>` for chart configuration. Chart.js loaded from `https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js` — pinned major.
2. **Real data only — never invent.** The dataset is the source of truth. If the user gives 9 months of data, you show 9, not 12. If a column is missing, you ask, you don't fabricate.
3. **3-5 KPI tiles.** Less than 3 = page feels empty. More than 5 = no hero. Pick the load-bearing metrics from the dataset (totals, deltas vs prior period, key ratios).
4. **2-3 charts maximum.** One hero chart (the trend that matters most) + one secondary chart (a cut: cohort, breakdown, comparison). A third only if it tells a genuinely new story.
5. **Chart canvases live inside fixed-height wrappers.** `<div style="position:relative; height:280px"><canvas></canvas></div>`. Chart.js with `responsive: true, maintainAspectRatio: false` enters a ResizeObserver infinite loop without a fixed parent height — the chart grows until it freezes the tab. This is the single most common Chart.js footgun.
6. **Data table at the bottom, not the top.** The reader's eye goes KPI → trend → cut → raw rows. Reversing this is a denser-feels-smarter mistake — it's a worse hierarchy.
7. **Tokens in `:root`, hex only there.** Same discipline as `artifact`. Switching the report's accent color or font family should be a single-token edit, not a search across 40 lines.

---

## File shape — exactly this order

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{Report title}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    /* 1. TOKENS */
    :root {
      --bg: #fafafa; --surface: #ffffff; --fg: #0a0a0a; --muted: #6b7280;
      --border: #e5e7eb; --accent: #2563eb; --accent-soft: rgba(37,99,235,0.10);
      --good: #16a34a; --warn: #eab308; --bad: #dc2626;
      --radius: 10px; --gutter: 24px;
      --font-display: "Inter", -apple-system, system-ui, sans-serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
      --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg);
           font: 14px/1.55 var(--font-body); }
    .page { max-width: 1180px; margin: 0 auto; padding: 32px var(--gutter) 80px; }

    /* 2. HEADER */
    .report-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 32px; }
    .report-head h1 { font: 600 28px/1.2 var(--font-display); margin: 0; letter-spacing: -0.4px; }
    .report-head .meta { color: var(--muted); font-size: 13px; }

    /* 3. KPI ROW */
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: var(--gutter); margin-bottom: 40px; }
    .kpi { background: var(--surface); border: 1px solid var(--border);
           border-radius: var(--radius); padding: 20px 22px; }
    .kpi .label { color: var(--muted); font-size: 13px; text-transform: uppercase;
                  letter-spacing: 0.06em; }
    .kpi .value { font: 600 36px/1.1 var(--font-display); margin-top: 6px;
                  font-variant-numeric: tabular-nums; letter-spacing: -0.5px; }
    .kpi .delta { font-size: 13px; margin-top: 6px;
                  font-variant-numeric: tabular-nums; }
    .kpi .delta.up   { color: var(--good); }
    .kpi .delta.down { color: var(--bad); }

    /* 4. CHARTS */
    .charts { display: grid; grid-template-columns: 2fr 1fr;
              gap: var(--gutter); margin-bottom: 40px; }
    .chart-card { background: var(--surface); border: 1px solid var(--border);
                  border-radius: var(--radius); padding: 20px; }
    .chart-card h2 { font: 600 16px/1.2 var(--font-display); margin: 0 0 16px; }
    .chart-wrap { position: relative; height: 280px; }       /* CRITICAL */
    .chart-wrap.small { height: 220px; }
    @media (max-width: 800px) {
      .charts { grid-template-columns: 1fr; }
    }

    /* 5. TABLE */
    .data-table { background: var(--surface); border: 1px solid var(--border);
                  border-radius: var(--radius); overflow: hidden; }
    .data-table table { width: 100%; border-collapse: collapse; }
    .data-table th, .data-table td { padding: 12px 16px; text-align: left;
                                     font-variant-numeric: tabular-nums;
                                     border-bottom: 1px solid var(--border); }
    .data-table th { background: var(--bg); font-weight: 600; font-size: 12px;
                     text-transform: uppercase; letter-spacing: 0.06em;
                     color: var(--muted); position: sticky; top: 0; }
    .data-table tr:last-child td { border-bottom: none; }
    .data-table tr:hover td { background: var(--accent-soft); }
  </style>
</head>
<body>
  <div class="page">
    <header class="report-head" data-cx-id="head">
      <div>
        <h1>{Report title}</h1>
        <div class="meta">Range: {date-start} — {date-end} · Source: {dataset name}</div>
      </div>
    </header>

    <section class="kpis" data-cx-id="kpis">
      <div class="kpi"><div class="label">Revenue</div><div class="value">$248,400</div><div class="delta up">▲ 12.4% vs prev</div></div>
      <div class="kpi"><div class="label">Active customers</div><div class="value">1,842</div><div class="delta up">▲ 84</div></div>
      <div class="kpi"><div class="label">Churn</div><div class="value">2.1%</div><div class="delta down">▲ 0.3pp</div></div>
      <div class="kpi"><div class="label">ARPU</div><div class="value">$134.78</div><div class="delta up">▲ $4.20</div></div>
    </section>

    <section class="charts" data-cx-id="charts">
      <div class="chart-card">
        <h2>Monthly revenue</h2>
        <div class="chart-wrap"><canvas id="chart-revenue"></canvas></div>
      </div>
      <div class="chart-card">
        <h2>By cohort</h2>
        <div class="chart-wrap small"><canvas id="chart-cohort"></canvas></div>
      </div>
    </section>

    <section class="data-table" data-cx-id="table">
      <table>
        <thead><tr><th>Month</th><th>Revenue</th><th>New</th><th>Churned</th><th>Net</th></tr></thead>
        <tbody>
          <!-- one <tr> per data row, real values, never invented -->
        </tbody>
      </table>
    </section>
  </div>

  <script>
    // 6. DATA + CHARTS
    const monthly = [
      { month: '2026-01', revenue: 198000, new: 142, churned: 48, net:  94 },
      { month: '2026-02', revenue: 204500, new: 138, churned: 51, net:  87 },
      { month: '2026-03', revenue: 221000, new: 165, churned: 49, net: 116 }
      // ... real rows ...
    ];

    // Read styles from CSS variables — keeps the chart on-brand
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim();
    const muted  = css.getPropertyValue('--muted').trim();
    const border = css.getPropertyValue('--border').trim();

    new Chart(document.getElementById('chart-revenue'), {
      type: 'line',
      data: {
        labels: monthly.map(d => d.month),
        datasets: [{
          label: 'Revenue ($)',
          data: monthly.map(d => d.revenue),
          borderColor: accent,
          backgroundColor: accent + '22',     // 13% alpha
          tension: 0.3, fill: true,
          pointRadius: 3, pointHoverRadius: 5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: border }, ticks: { color: muted } },
          y: { grid: { color: border }, ticks: { color: muted,
               callback: v => '$' + (v/1000) + 'k' } },
        },
      },
    });

    new Chart(document.getElementById('chart-cohort'), {
      type: 'bar',
      data: {
        labels: ['Q3-25', 'Q4-25', 'Q1-26'],
        datasets: [{ label: 'Retained', data: [82, 78, 81], backgroundColor: accent }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: muted } },
          y: { grid: { color: border }, ticks: { color: muted, callback: v => v + '%' } },
        },
      },
    });

    // Fill the table from `monthly` so KPI + chart + table read the same data
    const tbody = document.querySelector('.data-table tbody');
    for (const d of monthly) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + d.month + '</td>' +
                     '<td>$' + d.revenue.toLocaleString() + '</td>' +
                     '<td>'  + d.new      + '</td>' +
                     '<td>'  + d.churned  + '</td>' +
                     '<td>+' + d.net      + '</td>';
      tbody.appendChild(tr);
    }
  </script>
</body>
</html>
```

That's the canonical shape. Tokens → header → KPIs → charts → table, in that order, every report.

---

## Computing KPIs from the dataset — the discipline

Every KPI tile shows:

- **Label** (one line, uppercase, muted).
- **Value** (formatted: `$248,400` not `248400`; `2.1%` not `0.021`; `1,842` not `1842`).
- **Delta** vs prior period (number + arrow + color). Up-good metrics (revenue, customers) use `--good` for up; down-good metrics (churn, p95 latency) use `--good` for DOWN. **The arrow direction is always literal change; the color is always semantic.** Mixing those is the most common mistake.

For "vs prior period," default to the immediately-preceding window of the same length (last 4 weeks vs the 4 weeks before that). If the dataset doesn't span two periods, write "no prior" in the delta — don't fabricate a baseline.

---

## Chart picking — which type for which question

| User question                                | Chart type                | Notes                                                    |
|---------------------------------------------|---------------------------|----------------------------------------------------------|
| "How is this trending over time?"            | Line                      | Tension 0.3 for slight smoothing; fill area at 13% alpha |
| "Compare across categories"                  | Bar (vertical)            | Sort descending; 5-10 categories max                     |
| "Share of total"                             | Stacked bar OR donut      | Donut only if ≤4 segments; otherwise stacked bar         |
| "Cohort retention"                           | Stacked bar OR line-per   | Stacked bar for ≤6 cohorts; lines if you need exact %    |
| "Distribution / how is it spread?"           | Histogram (bar with bins) | Pre-bin in JS; Chart.js doesn't bin automatically        |
| "Funnel / step-through"                      | Horizontal bar            | Bar widths show drop-off, sorted by step                 |

Two charts max in the hero/secondary slot — the third is only justified when it answers a question the first two cannot.

---

## Concrete examples — two complete reports

### Example 1 — monthly revenue + cohort retention

Input (user pastes JSON):

```json
[
  { "month": "2025-09", "revenue": 168000, "new_customers": 124, "churned": 42 },
  { "month": "2025-10", "revenue": 182000, "new_customers": 138, "churned": 47 },
  { "month": "2025-11", "revenue": 195000, "new_customers": 154, "churned": 51 },
  { "month": "2025-12", "revenue": 211000, "new_customers": 161, "churned": 49 },
  { "month": "2026-01", "revenue": 224000, "new_customers": 168, "churned": 55 },
  { "month": "2026-02", "revenue": 238000, "new_customers": 174, "churned": 58 }
]
```

Brief: "Monthly board update. Hero: revenue trend. KPIs: total revenue, net customer growth, MoM revenue growth, churn rate."

Agent writes `index.html` with:

- **KPI 1** Total revenue (sum of all months) `$1,218,000`, delta = "▲ 41.7% vs H2-2025" (prior 6 months).
- **KPI 2** Net customer growth (`sum(new) - sum(churned)`) `617`, delta vs prior period.
- **KPI 3** MoM revenue growth (last month / second-last month) `6.3%`, delta vs trailing average.
- **KPI 4** Churn rate (`sum(churned) / start-of-period customer base`). If start-of-period unknown, ask before fabricating.
- **Chart 1** Line: monthly revenue, last 6 months, accent fill at 13%.
- **Chart 2** Bar: net new customers (new − churned) per month.
- **Table** All 6 rows with month / revenue / new / churned / net, formatted.

### Example 2 — A/B test result + cohort traffic split

Input (CSV, 14 days):

```
day,variant,sessions,signups
2026-04-01,control,1840,52
2026-04-01,test,1820,71
...
```

Brief: "Did variant B beat control? One-screen result."

Agent writes `index.html` with:

- **KPI 1** Control conversion rate `2.83%`.
- **KPI 2** Variant B conversion rate `3.91%`, delta `▲ 38.2%` in `--good`.
- **KPI 3** Statistical significance `p < 0.01` (computed in JS — a real chi-square, not "looks significant").
- **KPI 4** Total sessions analyzed `51,240`.
- **Chart 1** Two lines (control + variant), day-by-day conversion rate.
- **Chart 2** Stacked bar of session split per day (confirming the test was 50/50).
- **Table** Daily numbers for both arms.

If the agent can't compute significance because sample size is too small or the inputs are missing, write `"insufficient data for p-value"` in the tile — never invent a number.

---

## Anti-patterns

- **Inventing data to fill gaps.** If the user gives 6 months, show 6. Padding to 12 with made-up rows is lying — and the user will notice on the first read. Ask for more data instead.
- **Chart canvas without a fixed-height wrapper.** ResizeObserver loop kills the tab. Wrap every `<canvas>` in `<div class="chart-wrap">` with `position: relative; height: NNNpx`.
- **D3 / ECharts / recharts.** Out of scope. Chart.js is the one library this skill ships. If the user explicitly wants D3, that's `data-visualization`, not this skill.
- **Decorative color palettes.** Eight colors for eight cohorts produces a rainbow nobody can read. Default: ONE accent for the primary series, muted gray for comparison series. Add a second accent only when there's a genuine A-vs-B story.
- **KPIs without deltas.** A number with no comparison is a fact, not a metric. If you can't compute a delta, label the tile differently ("Total to date") rather than show an empty change indicator.
- **Mixing semantic and literal coloring on the delta.** Up arrow + red color on revenue = unreadable. Arrow shows direction of change; color shows whether that change is good or bad. Two independent decisions per tile.
- **Letting the table grow past 30 rows.** If the dataset has 365 days, the table shows the last 30 (or rolls up to weekly) — the rest stays in the chart. Long tables in a one-page dashboard are scroll-fatigue.
