---
name: swiss-international-deck
description: 'A deck variant — Swiss / International Typographic Style. 12-column grid, sans-serif only (Helvetica / Inter Tight), one saturated accent on monochrome, generous negative space, no rounded corners, no shadows. Information-dense slides with strict alignment. Use for "Swiss", "International", "Helvetica", "strict grid", institutional / academic / design-literate audiences. Skip for warm consumer brands (use deck + Warm Soft).'
trigger: /swiss-international-deck
---

# Swiss International Deck — strict grid, one accent, no decoration

## Overview

A deck variant rooted in the Swiss / International Typographic Style of the 1950s — Müller-Brockmann, Hofmann, Lohse. Sans-serif only, strict mathematical grid, one accent color on monochrome, generous negative space, hairline rules in place of borders. The discipline is what makes it work: every alignment is intentional, every white space is sized, every type weight is chosen. Done well it reads as institutional / academic / "the message can stand on its own". Done badly it reads as a Word document with extra steps.

This skill extends `/deck` — copy the deck framework (1920×1080 canvas, keyboard nav, print stylesheet, localStorage position) verbatim, then apply the visual language below. Don't reinvent the deck shell.

If the brief is "warm" / "approachable" / "consumer", this is the wrong skill — reach for `/deck` + Warm Soft direction.

---

## Critical Constraints — read these first, every time

1. **Sans-serif only.** Helvetica Neue, Inter Tight, Inter. No serifs anywhere — not in the body, not in the kicker, not in the page number. A single serif character breaks the system.
2. **Single accent color.** Pick one of the four saturated hues below — Klein Blue `#002FA7`, Lemon Yellow `#FFD500`, Lime `#C5E803`, Safety Orange `#FF6B35`. Never mix two; never desaturate to "match the brand".
3. **12-column grid, 24px gutters, 96px outer margin on the 1920px canvas.** Every block snaps to grid columns; no off-grid placement; no eyeballed coordinates.
4. **`border-radius: 0` everywhere.** A single rounded corner is the line that separates Swiss from "Swiss-ish". Hard angles only.
5. **1px hairline rules.** Borders are 1px solid `--ink`. Never 2px, never dashed, never colored except in the accent block. No `box-shadow`, no gradients, no blur.
6. **Type scale is extreme.** Display 96px or larger; kicker 11px uppercase letter-spaced 0.12em; body 16–18px. The midrange (24px, 32px) barely exists. Reference Müller-Brockmann's *Grid Systems*.
7. **Page numbers and chrome at the corners, always.** Top-left: kicker / section label. Top-right: deck title. Bottom-left: page number `№05 / 12`. Bottom-right: date / venue. Never centered; never decorative.
8. **Use real numbers; never placeholder.** A Swiss deck is information-dense — every number on screen must come from the user's data. Lorem ipsum kills the style harder than a rounded corner.

---

## The visual language

### Color tokens

```css
:root {
  --ink:    #0a0a0a;
  --paper:  #fafaf8;          /* or #f7f5ee for warmer paper */
  --accent: #002FA7;          /* Klein Blue IKB; swap for one of the four */
  --rule:   #0a0a0a;
  --muted:  #6a6a6a;

  --font-display: "Inter Tight", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-body:    "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-mono:    "JetBrains Mono", ui-monospace, monospace;
}
```

For Lemon Yellow / Lime / Safety Orange variants, swap `--accent` and lift `--paper` to `#f7f5ee` (warmer cream pairs better with high-chroma yellows).

### Grid

```css
.slide-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  column-gap: 24px;
  padding: 96px 96px 64px;
  height: 100%;
}
.span-12 { grid-column: span 12; }
.span-8  { grid-column: span 8;  }
.span-6  { grid-column: span 6;  }
.span-4  { grid-column: span 4;  }
.span-3  { grid-column: span 3;  }
```

Every block on every slide opts into one of these spans. Off-grid placement is forbidden.

### Type scale

```css
.t-display  { font: 800 96px/0.95 var(--font-display); letter-spacing: -0.03em; text-wrap: balance; }
.t-hero     { font: 700 64px/1.05 var(--font-display); letter-spacing: -0.02em; text-wrap: balance; }
.t-section  { font: 600 32px/1.15 var(--font-display); letter-spacing: -0.01em; }
.t-body     { font: 400 18px/1.5  var(--font-body); }
.t-caption  { font: 500 13px/1.4  var(--font-body); color: var(--muted); }
.t-kicker   { font: 600 11px/1    var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; }
.t-numeric  { font: 600 96px/1    var(--font-mono); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
```

Mono on the kicker and on numerics — Inter alone doesn't have the right tabular feel; JetBrains Mono fixes it.

### Slide chrome (every slide)

```html
<div class="chrome chrome-tl">METRICS · Q3 2026</div>
<div class="chrome chrome-tr">Acme Operations Review</div>
<div class="chrome chrome-bl">№05 / 12</div>
<div class="chrome chrome-br">2026 · November</div>
```

```css
.chrome { position: absolute; font: 600 11px/1 var(--font-mono);
          letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink); }
.chrome-tl { top: 32px; left: 96px; }
.chrome-tr { top: 32px; right: 96px; }
.chrome-bl { bottom: 32px; left: 96px; }
.chrome-br { bottom: 32px; right: 96px; }
```

Corners, always. Never centered chrome.

---

## Slide patterns — the working vocabulary

Six patterns cover ~80% of Swiss decks. Compose a 12-slide deck from these; repeat a pattern across slides when the content rhythm calls for it.

### Pattern A — Cover

Full-bleed accent block on the left, paper on the right. Title bottom-left of the accent in reverse type (paper on accent). Deck metadata in the paper half.

```html
<section class="slide cover" data-screen-label="01 Cover" data-cx-id="slide-1-cover">
  <div class="cover-accent"><h1 class="t-display">Operations
    <br>Review<br>Q3 2026.</h1></div>
  <div class="cover-meta">
    <div class="t-kicker">№01 · COVER</div>
    <div class="t-body" style="margin-top: 32px;">Acme · prepared for the board · November 14, 2026.</div>
  </div>
</section>

<style>
  .cover { display: grid; grid-template-columns: 5fr 7fr; height: 100%; }
  .cover-accent { background: var(--accent); padding: 96px; display: flex; align-items: flex-end; }
  .cover-accent .t-display { color: var(--paper); }
  .cover-meta { padding: 96px; }
</style>
```

### Pattern B — Statement

One claim, set in display type, breathing in 8/12 columns. Margin column reserved on the right for the kicker and one supporting line.

```html
<section class="slide statement" data-screen-label="02 Thesis">
  <div class="slide-grid">
    <h2 class="t-hero span-8" style="margin-top: 18vh;">
      One product. One number. One quarter to move it.
    </h2>
    <aside class="span-3" style="grid-column-start: 10; align-self: end;">
      <div class="t-kicker">CONTEXT</div>
      <p class="t-caption" style="margin-top: 16px;">
        The board asked for a single operational lever. We picked deployment velocity.
      </p>
    </aside>
  </div>
</section>
```

### Pattern C — KPI tower

Four columns, one KPI per column. Large numeric value (96–128px), caption underneath, optional 1px hairline above.

```html
<section class="slide kpi-tower" data-screen-label="06 Metrics">
  <div class="slide-grid">
    <h3 class="t-section span-12">Metrics that moved.</h3>
    <div class="kpi span-3"><hr><div class="t-numeric">6.2×</div><div class="t-caption">Deploys per engineer per week. (1.4× in Q2.)</div></div>
    <div class="kpi span-3"><hr><div class="t-numeric">38s</div><div class="t-caption">Mean time to recovery. (22min in Q2.)</div></div>
    <div class="kpi span-3"><hr><div class="t-numeric">1</div><div class="t-caption">Production incident in Q3 to date. (6 in Q2.)</div></div>
    <div class="kpi span-3"><hr><div class="t-numeric">100%</div><div class="t-caption">Rollback success rate. (84% in Q2.)</div></div>
  </div>
</section>

<style>
  .kpi { padding-top: 64px; }
  .kpi hr { border: none; border-top: 1px solid var(--rule); margin: 0 0 24px; }
</style>
```

### Pattern D — Two-column compare

Vertical hairline divides 6/6. Left column is the *before*; right is the *after*. Same type and spacing on both sides.

### Pattern E — H-bar chart

Horizontal bars, each row's width proportional to the data value. Label on the left, value on the right end of the bar, accent fill, 1px ink rule on top of each row.

```html
<div class="hbar-row"><span class="t-body">North America</span>
  <div class="hbar-track"><div class="hbar-fill" style="width: 78%;"></div></div>
  <span class="t-numeric" style="font-size: 24px;">$4.2M</span></div>
```

### Pattern F — Closing manifesto

Left half accent block with a single closing line in reverse type. Right half is three bullet-shaped (no actual bullets) action items.

---

## Concrete examples

### Example 1 — five-slide investor update in Klein Blue

Brief: a quarterly investor update for a B2B SaaS. Five slides covering: cover, thesis, metrics, what changed, ask.

1. **S01 Cover** — Pattern A. Klein Blue accent left half; "Operations Review Q3 2026." in reverse type at 96px. Right half paper with kicker + one-line metadata.
2. **S02 Thesis** — Pattern B. "One product. One number. One quarter to move it." at 64px in 8 columns. Right margin holds the kicker `CONTEXT` and a one-sentence frame.
3. **S03 Metrics** — Pattern C. Four KPIs (`6.2×` deploys, `38s` MTTR, `1` incident, `100%` rollback success). Numerics in JetBrains Mono at 96px, captions in Inter 13px muted.
4. **S04 Causes** — Pattern D. Left column: "What we changed." Right column: "What it moved." Six lines per side, hairline divider, Inter 18px body.
5. **S05 Ask** — Pattern F. Klein Blue left half with "Approve the extension." in reverse type. Right half three action items in 18px body, each preceded by a 1px hairline.

All five inherit the corner chrome (`METRICS · Q3 2026` top-left, `Acme Operations Review` top-right, `№N / 5` bottom-left, `2026 · November` bottom-right).

### Example 2 — Lemon Yellow variant for a retail / consumer launch deck

Same patterns; swap `--accent: #FFD500` and `--paper: #f7f5ee`. Reverse type on yellow accent must be `--ink` (black), never paper — high-chroma yellows desaturate white text. Lift the type weight on reverse copy to 700+ so it holds against the bright field.

---

## Anti-patterns

- **Two accent colors.** Stop. One accent. The whole system depends on the monochrome-plus-one tension. A second hue collapses it.
- **Rounded corners on cards / chips / buttons.** Stop. `border-radius: 0` everywhere. A single 4px rounding is enough to break the language.
- **Serif anywhere.** Stop. Display, body, kicker, chrome — all sans. Reaching for a serif on the cover for "warmth" is the wrong impulse; it's not Swiss any more.
- **Drop shadows / gradients / blur.** Stop. The system is flat. Hierarchy comes from scale, weight, and white space — never from depth.
- **Centered chrome / page numbers.** Stop. Chrome lives at the four corners. Centered chrome reads as "default PowerPoint template".
- **Off-grid placement.** Stop. Every block snaps to a 12-column span. Eye-balled positions kill the precision the style depends on.
- **Lorem ipsum or placeholder numbers.** Stop. Swiss decks are information-dense by definition — real numbers from the user's data, or the slide doesn't ship.
- **Using this style for a warm consumer brand.** Stop. Wrong tool. Reach for `/deck` + Warm Soft direction; Swiss reads as institutional, not approachable.
