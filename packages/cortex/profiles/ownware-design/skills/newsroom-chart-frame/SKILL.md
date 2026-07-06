---
name: newsroom-chart-frame
description: 'Newsroom-quality typographic frame around a single data chart — condensed serif headline, thin axes, italic annotations, source line at bottom. Pairs with /data-visualization (which renders the D3 chart) — this skill is the FRAME and TYPOGRAPHY, not the chart. Use for editorial explainers, embedded magazine charts, social-share chart cards. Skip when the chart is decoration inside a dashboard (use /artifact inline SVG) or when interactivity is the point (then /data-visualization alone).'
trigger: /newsroom-chart-frame
---

# Newsroom Chart Frame — the typography around the data

## Overview

Most charts ship without a frame: a bare SVG floating in a page. Newsroom charts read differently because the frame is doing half the work — a confident serif headline that states the finding, italic annotations on the data points, a hairline axis, a source line that earns the reader''s trust. This skill is that frame.

The chart itself comes from `/data-visualization` (D3 line/bar/area) or from inline SVG. This skill supplies the wrapping discipline: type stack, layout proportions, axis treatment, annotation style, source attribution.

---

## Critical Constraints

1. **Headline states the finding, not the topic.** "Weekly active users tripled between 2022 and 2024." Not "Weekly active users, 2018–2026." The reader gets the takeaway in the headline; the chart provides the evidence.
2. **Condensed serif headline + Helvetica body.** Headline in `"Cheltenham"`, `"Source Serif Pro"`, or `"Playfair Display"` at 56–80px, weight 700, line-height 1.05. Body and source in `"Inter"` or `"Helvetica Neue"` at 14–16px.
3. **Hairline axes only.** Stroke 0.5px @ 60% opacity. Three to four ticks per axis maximum. No gridlines crossing the chart area. No outer frame around the SVG.
4. **Single-color trend line.** One ink color (the body text color). Use the accent ONLY for the one highlighted point or one annotated value. No multi-color category lines unless explicitly comparing series.
5. **Italic annotation labels.** Annotations sit inline with the chart in italic serif at 13–14px. They read as the reporter''s voice ("Crossed 1M users in March 2024"). Plain sans-serif annotations look spreadsheet-y.
6. **Source line at the bottom.** 11px monospace, 60% opacity, format `Source: <data origin> · Chart: <author or tool>`. Always. A chart without a source is a guess.
7. **One accent color.** NYT red `#a91d1d`, editorial mint `#5fb38a`, or warm orange `#d97757`. Pick one per chart.

---

## Layout proportions (paste-ready)

For a 1200×720 frame embed:

- **Kicker** at top: 11px uppercase, letter-spacing 0.14em, accent color. "GLOBAL · WEEKLY ACTIVE USERS · 2018–2026"
- **Headline** below kicker: 64px serif, weight 700, max-width 22ch.
- **Italic deck** under headline: 22px italic serif, opacity 0.7, max-width 38ch. The deck is one sentence that frames the chart''s context.
- **Chart area** occupies 58–62% of the frame vertical space.
- **Source line** at bottom: 11px monospace.

Padding: 64px top/sides, 48px bottom.

---

## The canonical frame (paste, then replace the chart)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ownware weekly active developers — 2024 to 2026</title>
  <style>
    :root {
      --paper: #f7f5ee;
      --ink:   #0e0e0e;
      --muted: #6b6b6b;
      --accent: #a91d1d;
      --font-display: "Source Serif Pro", "Cheltenham", "Playfair Display", Georgia, serif;
      --font-body:    "Inter", "Helvetica Neue", -apple-system, system-ui, sans-serif;
      --font-mono:    "JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--font-body); }
    .frame { max-width: 1200px; margin: 0 auto; padding: 64px 64px 48px; }
    .kicker { font: 600 11px/1 var(--font-body); letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin: 0 0 24px; }
    h1.headline { font: 700 64px/1.05 var(--font-display); letter-spacing: -0.01em; max-width: 22ch; margin: 0 0 18px; text-wrap: balance; }
    p.deck { font: italic 400 22px/1.4 var(--font-display); color: var(--muted); max-width: 38ch; margin: 0 0 40px; }
    .chart { width: 100%; aspect-ratio: 16 / 9; }
    .axis text { font: 400 12px var(--font-mono); fill: var(--muted); }
    .axis line, .axis path { stroke: var(--ink); stroke-width: 0.5; opacity: 0.6; }
    .trend  { fill: none; stroke: var(--ink); stroke-width: 2.5; }
    .annot  { font: italic 400 14px/1.3 var(--font-display); fill: var(--ink); }
    .annot.accent { fill: var(--accent); }
    .source { font: 400 11px/1 var(--font-mono); color: var(--muted); opacity: 0.7; margin: 32px 0 0; }
  </style>
</head>
<body>
  <article class="frame" data-cx-id="chart-frame">
    <div class="kicker">OWNWARE · WEEKLY ACTIVE DEVELOPERS · 2024–2026</div>
    <h1 class="headline">From a beta of fifty to a steady ten thousand in eighteen months.</h1>
    <p class="deck">Adoption climbed evenly through 2025 and broke trend after the local-first deploy ship in March 2026.</p>

    <svg class="chart" viewBox="0 0 1080 480" role="img" aria-labelledby="t d">
      <title id="t">Weekly active developers, 2024 to 2026</title>
      <desc id="d">Line chart climbs from 50 in early 2024 to 10,200 by mid 2026, with an inflection in March 2026.</desc>

      <!-- D3 or inline SVG renders here. The frame leaves room and supplies the styles. -->
      <g class="axis" transform="translate(0,440)"><!-- x-axis path + ticks --></g>
      <g class="axis" transform="translate(64,0)"><!-- y-axis path + ticks --></g>
      <path class="trend" d="M64,420 L240,400 L420,360 L600,300 L780,200 L900,80" />
      <circle cx="780" cy="200" r="5" fill="var(--accent)"/>
      <text class="annot accent" x="800" y="195">Mar 2026 · 6,400 — local-first deploy ships</text>
    </svg>

    <p class="source">Source: Ownware gateway analytics, weekly cohort · Chart: Ownware Design</p>
  </article>
</body>
</html>
```

Replace the placeholder `<path class="trend">` and the axis groups with real D3 output from `/data-visualization`, or with hand-computed inline SVG. The frame stays.

---

## Concrete examples

### Example A — Ownware adoption line chart, NYT-red accent

Brief: ship a single chart of weekly active developers from 2024 to 2026. The story is the inflection at March 2026 when local-first deploy shipped.

Output: the frame above, with one annotated point at March 2026 in `--accent: #a91d1d`. Source line credits the gateway analytics. Headline states the finding. Deck names the reason. The chart provides the evidence. No legend (only one series).

### Example B — Two-series comparison bar chart, editorial-mint accent

Brief: compare Ownware adoption vs. industry baseline for AI agent platforms.

Output: same frame structure. Headline: "Ownware grew 3x faster than the average AI agent platform in 2025." Two bars per category, the Ownware bar in `--accent: #5fb38a`, the baseline bar in `--ink`. Italic annotation on the Ownware bars only ("3.1×", "2.8×", "3.4×"). Source line credits both data origins.

---

## Anti-patterns

- **Headline that names the topic instead of stating the finding.** Stop. "Weekly active users" is a y-axis label, not a headline. "Weekly active users tripled" is a headline.
- **Multiple accent colors in the chart.** Stop. One accent per chart. If two series both need emphasis, the chart is asking the wrong question; split into two charts.
- **Gridlines crossing the chart area.** Stop. Three ticks per axis with hairline ticks only. The eye reads the trend, not the grid.
- **A legend when there is only one series.** Stop. The headline + the single line are the legend.
- **Sans-serif annotations.** Stop. Italic serif annotations carry the reporter''s voice; sans annotations look like spreadsheet labels.
- **No source line.** Stop. A chart without a source is unverifiable. The 11px monospace line at the bottom is non-negotiable.
