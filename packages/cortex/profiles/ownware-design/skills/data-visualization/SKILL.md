---
name: data-visualization
description: 'Build D3.js interactive charts and explanatory graphics as single-file HTML artifacts. D3 via CDN, no bundler. Use for editorial reports, dashboards needing zoom/hover/brush, election maps, time-series with axes. Skip for static dashboard charts (use inline SVG via /artifact) or for non-data art (use /artifact).'
trigger: /data-visualization
---

# Data Visualization — D3 charts that explain, not just decorate

## Overview

Most "data visualization" is decoration: a bar chart used because the page needed a graphic. This skill is for the cases where the chart IS the artifact — an editorial explainer, an interactive report, a dashboard panel the user genuinely needs to read. Output is a single self-contained HTML file, D3 loaded from CDN, structured so the user can swap data without touching code.

For a static inline-SVG chart in a normal artifact (a sparkline in a KPI card, a hardcoded polyline in a dashboard), use `artifact` — D3 is overkill. For an isolated explanatory chart that has to be interactive (hover, brush, zoom, transition), use this skill.

---

## Critical Constraints — read every time

1. **One file, D3 via CDN, no bundler.** `<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>`. No npm install, no module bundler, no React. JSX is fine if interactivity demands state — see `artifact` skill for the React-CDN pattern.
2. **Data inline, OR as a fetch from a relative path.** Inline JSON in `<script>` for small datasets (<1000 rows). For larger, `d3.csv('./data.csv')` from a sibling file — and the chart must have a "loading…" state and a visible error if fetch fails.
3. **Tokens first, in `:root`.** Chart colors reference `var(--accent)`, `var(--good)`, `var(--bad)`, `var(--muted)`. Hardcoded hex is a smell — fix on sight.
4. **Axis labels and units always.** A chart with "12.4" and no unit is a guess, not data. Every axis carries units; every legend entry carries what-it-means.
5. **Choose the chart for the question, not the cool factor.** Bar for comparison; line for change over time; scatter for correlation; map for geography; small multiples for compare-across-categories. Sankeys, chord diagrams, and force-directed graphs are usually wrong for the question being asked.
6. **Color-blind safe.** Don't rely on red-vs-green for status. Use shape + label, or a CVD-safe palette (ColorBrewer Set2 / Tableau Colorblind 10).
7. **Accessibility — title + desc on every SVG.** `<title>` and `<desc>` inside the SVG give screen-readers a chance. Add `role="img"` and `aria-labelledby`.

---

## The 9 chart families — when to use which

### 1. Bar chart (comparison across categories)

Question: "which is biggest?"

```html
<svg viewBox="0 0 600 360" role="img" aria-labelledby="bar-title bar-desc">
  <title id="bar-title">Engineering hours by team, Q3 2026</title>
  <desc id="bar-desc">Platform team logs the most engineering hours.</desc>
  <g id="bars"></g>
</svg>
<script>
  const data = [
    { team: 'Platform', hours: 1240 },
    { team: 'Growth', hours: 890 },
    { team: 'Design', hours: 720 },
    { team: 'Infra', hours: 540 },
  ];

  const margin = { top: 24, right: 24, bottom: 60, left: 72 };
  const W = 600, H = 360;
  const svg = d3.select('svg');
  const x = d3.scaleBand().domain(data.map(d => d.team)).range([margin.left, W - margin.right]).padding(0.3);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.hours)]).nice().range([H - margin.bottom, margin.top]);

  svg.append('g').attr('transform', `translate(0,${H - margin.bottom})`).call(d3.axisBottom(x));
  svg.append('g').attr('transform', `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(5));
  svg.append('text').attr('x', margin.left).attr('y', margin.top - 8)
    .text('hours').attr('fill', 'var(--muted)').style('font-size', '12px');

  svg.append('g').selectAll('rect').data(data).join('rect')
    .attr('x', d => x(d.team)).attr('y', d => y(d.hours))
    .attr('width', x.bandwidth()).attr('height', d => y(0) - y(d.hours))
    .attr('fill', 'var(--accent)');
</script>
```

**Use for:** comparisons across 3–12 categories. **Don't use for:** time series (use line); >20 categories (use horizontal bar or small multiples).

### 2. Line chart (change over time)

Question: "where's this going?"

Use `d3.line()`, add `curve(d3.curveMonotoneX)` for smooth-but-honest curves. Mark anomalies with `<circle>`s. Show units on the y-axis. If the y-axis doesn't start at zero, label it loudly.

```js
const line = d3.line()
  .x(d => x(d.date))
  .y(d => y(d.value))
  .curve(d3.curveMonotoneX);

svg.append('path')
  .datum(data)
  .attr('fill', 'none')
  .attr('stroke', 'var(--accent)')
  .attr('stroke-width', 2)
  .attr('d', line);
```

**Use for:** trends over time, 2–4 series. **Don't use for:** unordered categories; comparing >5 series (becomes spaghetti — use small multiples).

### 3. Area / stacked area (composition over time)

Question: "what's the mix, and how is it shifting?"

```js
const stack = d3.stack().keys(['mobile', 'desktop', 'tablet']);
const series = stack(data);
const area = d3.area()
  .x(d => x(d.data.date))
  .y0(d => y(d[0]))
  .y1(d => y(d[1]))
  .curve(d3.curveMonotoneX);

svg.selectAll('path').data(series).join('path')
  .attr('d', area)
  .attr('fill', (d, i) => ['var(--accent)', 'var(--good)', 'var(--warn)'][i]);
```

**Use for:** stacked composition over time, ≤5 series. **Don't use for:** absolute comparison (use grouped bars); >5 stacks (becomes unreadable).

### 4. Scatter (correlation between two variables)

Question: "are these related?"

Add a regression line if the correlation is the point. Add hover tooltips showing the row's actual values. Color-encode a third dimension (category) if helpful.

**Use for:** correlation, outlier detection. **Don't use for:** comparing two named things (use bar); time series with one variable (use line).

### 5. Heatmap (matrix of values)

Question: "where's the hot spot?"

```js
const color = d3.scaleSequential(d3.interpolateViridis).domain([0, d3.max(data, d => d.value)]);
svg.selectAll('rect').data(data).join('rect')
  .attr('x', d => x(d.day))
  .attr('y', d => y(d.hour))
  .attr('width', x.bandwidth())
  .attr('height', y.bandwidth())
  .attr('fill', d => color(d.value));
```

**Use for:** day×hour activity, geography×category, any 2-axis matrix. **Don't use for:** sequential time series (use line); fewer than 20 cells (use bar).

### 6. Small multiples (compare a pattern across categories)

Question: "is this trend happening everywhere or just here?"

A grid of small line/bar charts, same axes, one per category. Tufte's favorite for a reason — the eye compares shape instantly. Use `d3.scaleBand()` for the grid layout and one shared y-axis.

**Use for:** "show me this pattern across 6–24 segments." **Don't use for:** ≤4 categories (use overlay line chart); >36 categories (becomes a postage-stamp wall).

### 7. Choropleth map (geographic data)

Question: "where is it concentrated?"

Use `d3.geoPath()` with a projection. TopoJSON for the boundary data (smaller than GeoJSON). Quantile or quantize scale for color binning. Always include a legend showing the bin ranges.

```js
const projection = d3.geoAlbersUsa().fitSize([W, H], statesGeo);
const path = d3.geoPath(projection);
svg.selectAll('path').data(statesGeo.features).join('path')
  .attr('d', path)
  .attr('fill', d => color(dataByState.get(d.properties.name) ?? 0))
  .attr('stroke', 'var(--border)');
```

**Use for:** state/country/region data. **Don't use for:** non-geographic comparison (use bar); cities sized by data (use proportional symbol map instead).

### 8. Network graph (relationships between entities)

Question: "who is connected to whom?"

`d3.forceSimulation()` with link, charge, and center forces. **Caveat:** force-directed graphs look impressive but are often the wrong answer — they're hard to read past ~30 nodes. If the question is "which 3 nodes are most connected," use a bar chart of degree. Only use the network if the *shape of the connections* is the insight.

### 9. Sankey / chord (flow between categories)

Question: "where does this flow from and to?"

Use `d3-sankey`. Only ship a Sankey if the flow is the story. Sankeys with too many nodes degenerate into spaghetti.

---

## Interactivity — the moves that earn the D3 dependency

If the chart isn't interactive, you didn't need D3 — inline SVG in the `artifact` skill would have done it. The justification for D3 is one or more of:

### Hover tooltips

```js
const tooltip = d3.select('body').append('div')
  .attr('class', 'tooltip')
  .style('position', 'absolute').style('pointer-events', 'none')
  .style('background', 'var(--surface)').style('border', '1px solid var(--border)')
  .style('padding', '8px 12px').style('border-radius', '6px').style('font', '13px/1.4 var(--font-body)')
  .style('opacity', 0);

svg.selectAll('rect')
  .on('mouseenter', (event, d) => {
    tooltip.style('opacity', 1).html(`<strong>${d.team}</strong><br>${d.hours.toLocaleString()} hours`);
  })
  .on('mousemove', (event) => {
    tooltip.style('left', (event.pageX + 12) + 'px').style('top', (event.pageY - 24) + 'px');
  })
  .on('mouseleave', () => tooltip.style('opacity', 0));
```

### Brushing (range selection on time series)

`d3.brushX()` on a sub-svg below the main chart; on `brush`, redraw the main chart's x-domain.

### Zoom

`d3.zoom().on('zoom', ...)` — be careful: zoom on a choropleth is useful; zoom on a bar chart is rarely the right answer.

### Transitions on data update

`selection.transition().duration(400).attr('y', d => y(d.value))` — animate to new state when the user changes a filter. Keep transitions under 400ms; longer feels sluggish.

---

## File shape — the canonical D3 artifact

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Engineering hours by team — Q3 2026</title>
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <style>
    :root {
      --bg: #fafafa; --surface: #ffffff; --fg: #111; --muted: #6b6b6b; --border: #e5e5e5;
      --accent: #2f6feb; --good: #17a34a; --warn: #eab308; --bad: #dc2626;
      --font-display: "Inter", system-ui, sans-serif;
      --font-body: "Inter", system-ui, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--font-body); padding: 32px; }
    h1 { font-family: var(--font-display); font-size: 24px; margin: 0 0 6px; }
    .subtitle { color: var(--muted); margin: 0 0 24px; }
    .chart-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 24px; }
    .axis text { font: 12px var(--font-body); fill: var(--muted); }
    .axis line, .axis path { stroke: var(--border); }
    .tooltip { position: absolute; pointer-events: none; }
  </style>
</head>
<body>
  <section data-cx-id="chart">
    <h1>Engineering hours by team — Q3 2026</h1>
    <p class="subtitle">Hours logged via the ops dashboard, July–September.</p>
    <div class="chart-wrap">
      <svg id="chart" viewBox="0 0 720 420" role="img" aria-labelledby="chart-title chart-desc">
        <title id="chart-title">Bar chart of engineering hours by team</title>
        <desc id="chart-desc">Platform leads with 1,240 hours; Infra trails at 540.</desc>
      </svg>
    </div>
  </section>

  <script>
    const data = [
      { team: 'Platform', hours: 1240 },
      { team: 'Growth', hours: 890 },
      { team: 'Design', hours: 720 },
      { team: 'Infra', hours: 540 },
    ];
    // … render code (see Bar example above)
  </script>
</body>
</html>
```

Same `:root` discipline as a normal artifact. Same `data-cx-id` anchors on top-level regions. Just D3 loaded from CDN and a chart instead of static HTML content.

---

## Concrete examples

### Example A — "Show me the conversion funnel by step"

Brief: marketing wants an interactive funnel showing drop-off at each step of signup, with hover for raw numbers.

Choice: horizontal bar chart with stage labels on the left. Bars sized by users-at-step. Hover shows count + drop-off-from-previous-step.

Why not a "real" funnel shape: funnel-shape SVGs look impressive but are harder to read than horizontal bars. The percentage decrease is what matters; bars make it instantly readable.

Output: one HTML file with the bar chart + hover tooltip. Data inline (5 stages, small). Total file: ~120 lines.

### Example B — "Build an election map for our company-wide poll"

Brief: 1500 employees voted on a policy across 12 offices.

Choice: choropleth-by-office (small map of office locations, each office sized by employee count, colored by vote percentage). Add hover for office name + vote breakdown.

Why not a 2-D choropleth of states: the data is by office, not by state. A proportional-symbol overlay on a map is the right answer.

Output: one HTML file. Data loaded from `./poll-data.csv` because it has 1500 rows. Loading state + visible error path if the CSV fails to fetch.

---

## Anti-patterns

- **Reaching for D3 to render a sparkline in a KPI card.** Stop. That's inline SVG, 5 lines. Use `artifact` skill.
- **Reaching for a force-directed graph because the data has relationships.** Stop. Ask the actual question. If it's "who has the most connections," use a bar chart of degree. Force graphs are usually wrong.
- **Reaching for a 3D chart, a doughnut chart with 12 slices, or a "creative" radial layout.** Stop. The user has to read the chart. Decoration is the enemy of comprehension.
- **Reaching for default D3 colors (`d3.schemeCategory10`).** Stop. Those colors don't match the brand and aren't CVD-safe. Use `var(--accent)`, `var(--good)`, etc., or ColorBrewer/Tableau Colorblind 10 if you need a palette.
- **Reaching for an interactive chart where a static one would do.** Stop. If the user just needs to see the shape, static SVG is faster, accessible, prints cleanly, and doesn't depend on JS. Use D3 only when hover/brush/zoom/transitions are load-bearing.
- **Reaching for chart with no units, no title, no source.** Stop. Every chart carries: a title, units on every axis, a one-line caption explaining the takeaway, and a source line ("Source: ops dashboard, Q3 2026"). Without these, the chart is a guess.
