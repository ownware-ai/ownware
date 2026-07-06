---
name: layout-grids
description: 'Pick the right grid for the brief — 12-col flex / Swiss strict / asymmetric editorial / bento / golden-ratio / single-column — with a decision tree and real CSS. Use when starting any layout, when sections feel loose, or when the brief calls for editorial / magazine feel the default 12-col can''t express. Pairs with /web-guidelines (baselines) and /whitespace-system (rhythm). Skip for single-page forms or single charts — overkill.'
trigger: /layout-grids
---

# Layout Grids — pick the grid, the rest follows

## Overview

A grid is the skeleton the whole artifact hangs from. Pick the wrong one and every section fights it. Pick the right one and the layout decisions stop being decisions — column counts, gutter widths, where text breaks, all fall out of the grid choice.

This skill covers the six grid systems that earn their keep on the web. Each has a decision rule ("use when…"), real CSS, and a worked example. Default is the 12-col flex grid — it covers 70% of artifacts. The other five exist because 12-col flattens nuance: a magazine spread, a bento dashboard, and a Swiss-restraint brand page each need something the 12-col can't give cleanly.

Pair this skill with `/web-guidelines` for the underlying numeric baselines (container widths, gutters, side-padding) and `/whitespace-system` for the gap rhythm inside the grid.

---

## Critical Constraints

1. **One grid per artifact, unless you have a reason.** The hero, features, and CTA can sit inside the same 12-col grid. Switching to a 9-col Swiss grid for one section and back to 12-col is a smell — pick one skeleton.
2. **Gutters belong to the grid, not the children.** Set `gap` on the `grid` container. Never `margin-right: 32px` on each card.
3. **Container max-width is the outer ceiling.** 1200px for marketing, 1440px for dashboards, 1680px for tooling-density screens, 720-840px for long-form editorial. Past those values, lines lose readability and grids start looking lost on ultra-wide monitors.
4. **`minmax(0, 1fr)`, not `1fr` alone.** Plain `1fr` breaks when children have intrinsic min-content (long words, code blocks). `minmax(0, 1fr)` lets columns shrink past intrinsic size and prevents grid overflow.
5. **Named grid areas for asymmetric layouts.** When the grid isn't repeatable columns, name the tracks — `grid-template-areas` is more readable than `grid-column: 3 / span 4`.
6. **Never `display: grid` with `position: absolute` children.** Absolute kills participation in the grid. If a child must overlay, layer it inside a single grid cell with `z-index` and a transform.

---

## The six grids — decision tree

### 1. 12-col flex grid — the default

**Use when:** marketing landings, B2B product pages, anything with a CTA + features + proof shape. The "Stripe / Vercel / Linear" zone.

```css
.container {
  max-width: 1200px;
  margin-inline: auto;
  padding-inline: clamp(24px, 4vw, 48px);
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 32px;
}
.span-12 { grid-column: span 12; }
.span-8  { grid-column: span 8; }
.span-6  { grid-column: span 6; }
.span-4  { grid-column: span 4; }
.span-3  { grid-column: span 3; }
@media (max-width: 768px) {
  .container { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; }
  .span-4, .span-3 { grid-column: span 3; }
  .span-6, .span-8 { grid-column: span 6; }
}
```

Hero spans 12. Three-feature row spans 4-4-4. Pricing tier row spans 4-4-4. Two-up testimonial section spans 6-6. Two-column "split" hero spans 7-5 with the visual on the wider side.

### 2. Swiss strict — 9-col with hairlines

**Use when:** restrained brand pages, editorial typography studies, "the design is the design." Heavy on white space, hairline rules (`1px solid var(--border)`), uppercase labels with positive tracking.

```css
.swiss {
  max-width: 1080px;
  margin-inline: auto;
  padding-inline: 48px;
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: 24px;
  border-top: 1px solid var(--border);
  padding-block: 96px;
}
.swiss-label  { grid-column: span 2; font-size: 12px; text-transform: uppercase; letter-spacing: 0.10em; color: var(--muted); }
.swiss-body   { grid-column: span 7; }
.swiss-h       { font-size: 56px; line-height: 1.05; letter-spacing: -0.02em; font-weight: 500; }
```

The 2-7 split (label on the left, content on the right) is the Swiss signature. Hairline borders separate sections. White space carries the weight.

### 3. Asymmetric editorial — body + marginalia

**Use when:** magazine articles, longform features, premium content where pull-quotes and footnotes need a home. Inspired by print magazine layouts (The New Yorker, MIT Press editions).

```css
.editorial {
  max-width: 1200px;
  margin-inline: auto;
  padding-inline: 48px;
  display: grid;
  grid-template-columns: 1fr minmax(0, 65ch) 1fr;  /* gutter | body | margin */
  gap: 32px;
}
.editorial > .body      { grid-column: 2; }
.editorial > .margin    { grid-column: 3; font-size: 14px; color: var(--muted); }
.editorial > .full-bleed { grid-column: 1 / -1; }   /* hero image, pull-quote */
.editorial > .wide      { grid-column: 2 / 4; }     /* image extends into margin */
```

Body column locks at 65ch — the readability sweet spot. The right "margin" column holds pull-quotes, footnotes, author bio. `full-bleed` breaks the grid for the hero photo. The left gutter is empty white space — the air the editorial relies on.

### 4. Bento — card-tile grid

**Use when:** Apple-product-page style feature grid, dashboard summary tiles, "showcase 6-9 features without making them feel like a list." Tiles are different sizes; the bigger tile gets the lead feature.

```css
.bento {
  max-width: 1200px;
  margin-inline: auto;
  padding-inline: 24px;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-auto-rows: 200px;
  gap: 16px;
}
.bento-card    { background: var(--surface); border-radius: 16px; padding: 24px; border: 1px solid var(--border); }
.bento-lead    { grid-column: span 4; grid-row: span 2; }  /* 4×2 — the hero tile */
.bento-tall    { grid-column: span 2; grid-row: span 2; }
.bento-wide    { grid-column: span 4; grid-row: span 1; }
.bento-square  { grid-column: span 2; grid-row: span 1; }
@media (max-width: 768px) { .bento > * { grid-column: span 6; grid-row: span 1; } }
```

The 4×2 lead tile carries the headline feature. Two-tall tiles flank it on the right. The remaining row is two wide-or-square tiles. Mobile collapses to a single column — bento is a desktop-up move.

### 5. Golden-ratio split — 1 : 1.618

**Use when:** hero sections where one side is type and the other is image; product pages where the gallery and the spec column need an unbalanced but pleasing split.

```css
.golden {
  max-width: 1200px;
  margin-inline: auto;
  padding-inline: 48px;
  display: grid;
  grid-template-columns: 1fr 1.618fr;  /* type | image */
  gap: 48px;
  align-items: center;
}
/* OR reversed — image on the left, type on the right */
.golden.reversed { grid-template-columns: 1.618fr 1fr; }
```

`1 : 1.618` reads more dynamic than `1 : 1` (which feels stiff) and more balanced than `1 : 2` (which feels off). The smaller column gets the type (text doesn't need width past 65ch); the larger gets the visual (which thrives on width).

### 6. Single-column long-form

**Use when:** essays, documentation pages, blog posts. Type is the whole UI. No sidebar, no marginalia.

```css
.longform {
  max-width: 720px;
  margin-inline: auto;
  padding: 96px 24px;
}
.longform p, .longform li { font-size: 18px; line-height: 1.65; max-width: 65ch; text-wrap: pretty; }
.longform h1 { font-size: 48px; line-height: 1.1; letter-spacing: -0.02em; text-wrap: balance; }
.longform h2 { font-size: 28px; line-height: 1.2; margin-top: 64px; }
.longform figure { margin: 48px -64px; }  /* full-bleed image — slightly wider than text */
```

720px max. Body at 18px (lifted from 16px — editorial bodies want more). Figures break the column to feel cinematic.

---

## Concrete examples

### Example 1 — Pricing page on the 12-col grid (4-4-4 tier split)

```html
<section data-cx-id="pricing" class="container">
  <header class="span-12" style="text-align: center; padding-block: 80px 48px;">
    <h2>Simple pricing</h2>
    <p>Three tiers. No hidden fees.</p>
  </header>

  <article class="span-4 tier">
    <h3>Starter</h3>
    <p class="price">$0<span>/mo</span></p>
    <ul>…</ul>
    <a class="btn-secondary">Get started</a>
  </article>
  <article class="span-4 tier featured">
    <h3>Pro</h3>
    <p class="price">$29<span>/mo</span></p>
    <ul>…</ul>
    <a class="btn-primary">Start free trial</a>
  </article>
  <article class="span-4 tier">
    <h3>Team</h3>
    <p class="price">$99<span>/mo</span></p>
    <ul>…</ul>
    <a class="btn-secondary">Contact sales</a>
  </article>
</section>
```

```css
.tier { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; }
.tier.featured { border-color: var(--accent); box-shadow: 0 0 0 4px oklch(0.95 0.04 263); }
```

Three equal `span-4` tiers. The featured tier gets a colored border + a halo — same grid cell, visual lift via CSS. On mobile, `span-4` collapses to `span-3` of the 6-col mobile grid, stacking each tier to full width.

### Example 2 — Editorial article with asymmetric body + marginalia

```html
<article class="editorial">
  <figure class="full-bleed">
    <img src="hero.jpg" alt="Hero photo" />
  </figure>

  <header class="body" style="padding-block: 64px 32px;">
    <p class="kicker">Profile · Issue 04</p>
    <h1>The architecture of restraint</h1>
    <p class="byline">By Sam Rivera · 12 min read</p>
  </header>

  <p class="body">A long opening paragraph that sets the scene, written at 18px on 1.65 line-height, capped at 65ch so the eye finds the next line without effort…</p>

  <aside class="margin">
    <p class="pull">"The best decisions are the ones you stop having to make."</p>
  </aside>

  <p class="body">More body…</p>

  <figure class="wide">
    <img src="diagram.svg" alt="Diagram" />
    <figcaption>The grid extends into the right margin — drawing the eye sideways.</figcaption>
  </figure>

  <p class="body">More body, returning to the column…</p>
</article>
```

Body locked at 65ch. Pull-quote lives in the right margin — visible, not interrupting. The diagram (`.wide`) extends into the margin column for emphasis. The hero `.full-bleed` breaks the grid entirely, the article's loudest moment.

---

## Anti-patterns

- **`display: flex` on a row of cards because "it's simpler."** Stop. Flex stretches children to equal heights but doesn't snap them to columns. The third card on a 1230px viewport sits at a different x-coordinate from where it'd land at 1240px — sub-pixel jitter. Use grid; the columns lock.
- **Switching grid systems mid-page.** Hero on 12-col, features on bento, pricing on Swiss — three skeletons in one artifact. The eye notices every seam. Pick one.
- **`grid-template-columns: 1fr 1fr 1fr` when you mean three cards.** Use `repeat(3, minmax(0, 1fr))` — same result, less magic, and the `minmax(0, 1fr)` saves you from intrinsic-content overflow.
- **Hardcoding `margin` between cards inside a grid container.** Use `gap`. Margin compounds (last-child margin doesn't collapse against the container), and resizing the grid means hunting margins down. `gap` is one property; the grid owns the rhythm.
- **`position: absolute` to "fix" a child that doesn't fit.** If the child doesn't fit, the grid is wrong — the child isn't. Re-pick spans or switch grids. Absolute positioning breaks responsive behavior and accessibility tree order.
- **Ultra-wide containers (no max-width) on a marketing page.** A hero spanning 2560px wide reads as broken. Cap at 1200px (marketing) or 1440px (dashboards). The visible whitespace on either side is the design, not a mistake.
- **Bento on mobile.** A 4×2 lead tile + 2×2 tile + 2×1 tile on a 375px-wide screen is a disaster — every tile becomes a postage stamp. Bento is desktop-up; mobile collapses to a single column of full-width tiles.
