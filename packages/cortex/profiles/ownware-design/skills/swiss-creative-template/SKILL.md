---
name: swiss-creative-template
description: 'Swiss-style deck or page with creative-mode tweak. Strict grid, Helvetica/Inter only, monochrome with one accent — but every slide deliberately breaks ONE rule (oversized headline, bleed image, color block in unexpected position). Use when the brief asks for Swiss/editorial deck with energy, agency creative-mode work, or "Swiss but louder". For the restrained version use /swiss-international-deck. Skip for fully brutalist briefs (use /poster-design).'
trigger: /swiss-creative-template
---

# Swiss Creative Template — discipline plus one intentional break per slide

## Overview

The Swiss tradition gives you grid, type, and silence; this variant adds one deliberate rule-break per slide so the deck has energy. Think of it as Müller-Brockmann after coffee. Adjacent skill: `/swiss-international-deck` (restrained, no breaks) — pick this one when the audience is creative, agency, or brand-led.

This is a deck pattern. Use the `/deck` framework for the canvas, scaling, and nav; this skill governs typography, palette, and the rule-break discipline.

---

## Critical Constraints — read these first, every time

1. **Type stack is fixed.** `Helvetica Neue, Inter, system-ui, sans-serif`. No serifs anywhere except the accent break (rule 6). No display-script fonts. Numerals: `font-variant-numeric: tabular-nums`.
2. **Palette is monochrome plus ONE accent.** Paper `#f4f0e6` (or `#ffffff`), ink `#0a0a0a`, mid grey `#6b6b6b`, border `#0a0a0a`. Accent — one only, picked from the brief — examples: hot red `#e63946`, electric blue `#1d4ed8`, neon yellow `#f5d300`, hot pink `#ff3399`.
3. **Grid is 12 columns, 80px gutter, 96px outer margin** on the 1920×1080 deck canvas. Every region snaps to columns. Asymmetric layouts use whole-column offsets, never half-columns.
4. **Type scale.** Display `120–240px / 0.92 line-height / -0.04em tracking / weight 700–900`. H2 `64px / 1.05 / -0.02em / 600`. Body `28px / 1.4 / 400`. Caption `16px / 1.3 / 500 / +0.12em uppercase`.
5. **One rule-break per slide. Exactly one. Documented in a CSS comment.** No break = boring Swiss. Two breaks = chaos. The break is the slide's signature move.
6. **Approved breaks (pick one per slide):**
   1. **Oversized headline that bleeds past the column grid** (e.g. headline `380px` wide on a 1920px canvas, ignoring 12-column rhythm).
   2. **Image bleed off one edge** (image escapes left or right margin, never both).
   3. **Color block in unexpected position** (accent square in the dead center of a content slide, or anchored to a corner that breaks reading order).
   4. **A single word in a contrasting serif** (Times New Roman 1 word inside an otherwise-sans deck — high-leverage move, use on max one slide in the deck).
   5. **Type rotation** (one element rotated 90° along the left edge, set vertical — labels, dates, footers).
7. **Hierarchy preserves.** The break is visual, not informational. A reader scanning the slide still finds H2 > body > caption. If the break confuses what to read first, it's broken — undo it.

---

## The five rule-breaks — when to use which

| Break                          | When it works                                         | When to avoid                              |
|--------------------------------|-------------------------------------------------------|--------------------------------------------|
| Oversized bleed headline       | Cover slide, section dividers, one chapter opener     | Data slides — competes with the number     |
| Image bleed off one edge       | Visual quote, brand cover, product hero               | Comparison slides — asymmetry confuses     |
| Color block in unexpected spot | Energy slide (a "wow" moment), product launch reveal  | Footer-heavy slides — fights with chrome   |
| Serif word                     | The single thesis sentence of the deck                | Anywhere with more than 12 words on screen |
| Type rotation                  | Footer-side annotations, slide number, chapter label  | Body content — slows the read              |

Rule of thumb: a 5-slide creative deck uses three to four different breaks across the deck. Repeating the same break on every slide kills the energy you spent it on.

---

## Concrete examples — a 5-slide creative-mode deck

Brief: launching a music-distribution startup. 5-slide creative-mode deck — `/deck` canvas, this skill's palette + breaks.

Tokens:

```css
:root {
  --paper: #f4f0e6;
  --ink: #0a0a0a;
  --muted: #6b6b6b;
  --border: #0a0a0a;
  --accent: #e63946;            /* hot red */
  --font-sans: "Helvetica Neue", Inter, system-ui, sans-serif;
  --font-serif: "Times New Roman", Georgia, serif;  /* break #4 only */
}
```

### Slide 1 — Cover (break: oversized headline bleed)

```html
<section class="slide" data-cx-id="slide-1-cover">
  <!-- BREAK: headline at 320px bleeds past 12-column grid intentionally -->
  <h1 style="font: 900 320px/0.85 var(--font-sans); letter-spacing: -0.05em;
             margin: 0 -120px 0 96px; text-wrap: balance;">
    BOOST<br/>YOUR<br/>SOUND.
  </h1>
  <div style="position:absolute; bottom:96px; left:96px;
              font:500 16px/1 var(--font-sans); letter-spacing:0.12em; text-transform:uppercase;">
    Stem · Q3 launch · 2026
  </div>
</section>
```

### Slide 2 — Thesis (break: single serif word)

```html
<section class="slide" data-cx-id="slide-2-thesis">
  <!-- BREAK: one word ("artists") in Times Roman inside an otherwise-sans deck -->
  <h2 style="font:600 96px/1.05 var(--font-sans); letter-spacing:-0.02em; max-width:1400px;">
    Independent <span style="font:400 96px/1.05 var(--font-serif); font-style:italic;">artists</span>
    keep 100% of their royalties.
  </h2>
  <p style="font:400 28px/1.4 var(--font-sans); color:var(--muted); max-width:900px; margin-top:48px;">
    No middlemen. No locked catalogs. Stem ships to every platform on day one and pays out weekly.
  </p>
</section>
```

### Slide 3 — Data (break: accent color block in unexpected position)

```html
<section class="slide" data-cx-id="slide-3-data" style="position:relative;">
  <!-- BREAK: hot-red square anchored to dead-center, breaks expected top-left flow -->
  <div style="position:absolute; left:50%; top:50%;
              width:280px; height:280px; background:var(--accent);
              transform:translate(-50%,-50%);"></div>
  <h2 style="position:relative; z-index:1; font:700 200px/0.95 var(--font-sans);
             letter-spacing:-0.04em; text-align:center; mix-blend-mode:difference;
             color:#fff; font-variant-numeric:tabular-nums;">
    12M
  </h2>
  <p style="position:absolute; bottom:160px; left:0; right:0; text-align:center;
            font:500 24px/1 var(--font-sans); letter-spacing:0.08em; text-transform:uppercase;">
    Streams routed through Stem in beta · 9 months
  </p>
</section>
```

### Slide 4 — Visual (break: image bleeds off right edge)

```html
<section class="slide" data-cx-id="slide-4-visual" style="display:grid; grid-template-columns:1fr 1fr; gap:64px;">
  <div style="padding:96px;">
    <h2 style="font:700 88px/1.05 var(--font-sans); letter-spacing:-0.02em;">Built by the engineers who shipped Spotify Wrapped.</h2>
    <p style="font:400 24px/1.45 var(--font-sans); color:var(--muted); margin-top:32px;">Production-grade pipelines, day-one.</p>
  </div>
  <!-- BREAK: image bleeds 200px past the right edge of the canvas -->
  <div style="margin-right:-200px; background:linear-gradient(135deg,#222,#000);
              border-left:8px solid var(--accent);">
    <!-- product mock or photograph -->
  </div>
</section>
```

### Slide 5 — Close (break: type rotation on left edge)

```html
<section class="slide" data-cx-id="slide-5-close" style="position:relative;">
  <h2 style="font:700 120px/1 var(--font-sans); letter-spacing:-0.03em; max-width:1400px;">
    Ship your sound this Friday.
  </h2>
  <a style="display:inline-block; margin-top:64px; padding:24px 48px; background:var(--accent);
            color:#fff; font:700 28px/1 var(--font-sans); text-decoration:none;">
    stem.fm/early
  </a>
  <!-- BREAK: footer rotated 90° along left edge -->
  <div style="position:absolute; left:48px; bottom:96px; transform:rotate(-90deg); transform-origin:left bottom;
              font:500 14px/1 var(--font-sans); letter-spacing:0.16em; text-transform:uppercase;">
    Stem · independent music distribution · 2026
  </div>
</section>
```

5 slides, 5 different breaks. Each documented in a CSS comment so the next editor knows which line is the intentional rule-violation.

---

## Workflow

1. **Pick the accent first**, before any layout. The accent carries 50% of the deck's energy; a wrong choice can't be recovered with layout.
2. **Sketch the grid on every slide.** Even when a break ignores the grid, you sketch the grid first, then mark the break.
3. **Allocate breaks across slides BEFORE writing CSS.** Map slide → break-type as a one-line list. Re-using a break twice is fine in a 10+ slide deck; not in a 5.
4. **Mark every break with a `/* BREAK: <kind> */` CSS comment.** The next editor knows where the intentional rule lives.
5. **Run `/critique` after the draft.** A creative deck with no rhythm scores R 2/5 even if every slide individually looks good. Fix at the deck level.

---

## Anti-patterns

- **Every slide breaks the same way.** Five oversized headlines in a row = one move repeated, not a deck with energy. Vary the break.
- **Multiple breaks per slide.** A slide with three rule-violations looks like a student exercise. One break, one slide.
- **Picking three accents because "more is more."** Swiss is a one-accent tradition. Two accents is a different language (post-modern). Stay in the single-accent zone for this skill.
- **Using a script or display font for the "serif break."** The break is Times New Roman or Georgia — a familiar serif against the sans baseline. Brush script is a different aesthetic, doesn't belong here.
- **Breaking the grid AND breaking the type AND breaking the color.** That's not Swiss-creative; that's brutalist (see `/poster-design`). If the brief wants that, use a different skill.
