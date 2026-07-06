---
name: field-notes-editorial
description: 'Notebook aesthetic for research articles, lab reports, and observation logs — kraft paper background, dot-grid texture, monospace body, inline hand-drawn SVG sketches, marginalia annotations. Use when the brief is "research notes", "engineering log", "field study", "process journal", or any piece that should read like a draftsman''s notebook. Layered on top of /article-layout. Skip for marketing pages (the kraft reads too lo-fi) and skip for pieces with no diagrams (the affordances under-earn).'
trigger: /field-notes-editorial
---

# Field Notes Editorial — kraft paper, dot grid, marginalia

## Overview

Some pieces want to feel found rather than published — a working notebook left on a desk, not a glossy article. This skill is the recipe for that feeling. Kraft-toned paper, faint dot grid, mono body type, inline sketches, handwritten-looking marginalia in the side margin. The reader trusts what they're reading because the format admits it's still thinking.

Pair with `/article-layout` for the structural moves (h2, footnotes, ornament). The token block + the four marginalia affordances below are the style layer.

---

## Critical Constraints — read these first, every time

1. **Kraft paper, not white.** `--bg: #E8DCC0` (warm kraft) with a faint dot-grid background image. Pure white shatters the notebook illusion.
2. **Monospace body, not display mono.** `--font-body: "IBM Plex Mono", "JetBrains Mono", ui-monospace` at 15–16px. Body is the whole article — the eye has to read it for 10 minutes. IBM Plex Mono is the lightest mono that still reads as mono.
3. **Marginalia, not sidebars.** Asides appear in the LEFT margin, smaller type, indented and slightly rotated. This is the signature move. If your aside reads as a panel block, the voice broke.
4. **Inline sketches as SVG, never raster.** Diagrams are drawn as small inline `<svg>` blocks with hand-drawn-looking strokes (`stroke-linecap: round`, `stroke-width: 1.5`, slight imperfection in coordinates). Stock icons kill the voice.
5. **One ink color only.** `--ink: #2B2418` (deep brown-black). Ink doesn't go red, blue, or anything else. Underlines and emphasis use a `--highlighter` for *content*, but the page's primary mark is one color.
6. **Visible grid, restrained.** Dot grid at 24px spacing, 8% opacity. The reader should sense it, not count it.

---

## The token block (paste verbatim into `:root`)

```css
:root {
  --bg: #E8DCC0;             /* warm kraft */
  --paper: #F0E6CC;          /* one tone lighter for sketch panels */
  --ink: #2B2418;            /* the one ink color */
  --muted: #7A6F5C;          /* faded ink for byline, captions */
  --rule: #C8B89A;           /* hairline rules */
  --highlighter: #F2D85C;    /* yellow marker for inline emphasis only */
  --dot: rgba(43, 36, 24, 0.08);
  --font-display: "IBM Plex Sans", "Inter", -apple-system, sans-serif;
  --font-body: "IBM Plex Mono", "JetBrains Mono", ui-monospace, Menlo, monospace;
  --font-hand: "Caveat", "Patrick Hand", "Comic Neue", cursive;
}
body {
  margin: 0;
  background:
    radial-gradient(circle, var(--dot) 1px, transparent 1px) 0 0 / 24px 24px,
    var(--bg);
  color: var(--ink);
  font: 15px/1.65 var(--font-body);
}
```

Kraft + dot grid + mono ink. The whole identity in seven lines.

---

## Rubric — the notebook affordances

### Marginalia (the signature move)

A note that lives in the *left* margin, smaller and slightly tilted, in a handwriting-style font.

```html
<aside class="margin-note" data-pos="left">First test failed at 47°C — humidity?</aside>
```

```css
.body { position: relative; max-width: 62ch; margin: 0 auto 0 22vw; padding: 0 24px; }
.margin-note {
  position: absolute;
  left: -22vw; max-width: 18vw;
  font-family: var(--font-hand);
  font-size: 17px; line-height: 1.3;
  color: var(--muted);
  transform: rotate(-1.4deg);
}
@media (max-width: 1000px) {
  .body { margin: 0 auto; }
  .margin-note { position: static; transform: none; display: block;
                 margin: 16px 0; padding-left: 16px; border-left: 2px solid var(--rule); }
}
```

Mobile collapses the marginalia inline with a left rule — the voice survives at small width.

### Inline hand-drawn SVG sketch

```html
<figure class="sketch">
  <svg viewBox="0 0 240 120" stroke="var(--ink)" fill="none"
       stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20,80 C60,40 100,90 140,55 S200,30 220,60" />
    <circle cx="20" cy="80" r="3" fill="var(--ink)" />
    <circle cx="220" cy="60" r="3" fill="var(--ink)" />
    <text x="10" y="105" font-size="11" font-family="var(--font-hand)" fill="var(--muted)">t=0</text>
    <text x="200" y="85" font-size="11" font-family="var(--font-hand)" fill="var(--muted)">t=8m</text>
  </svg>
  <figcaption>Fig. 1 — temperature drift across the run.</figcaption>
</figure>
```

The slight coordinate imperfection and the hand-font labels carry the voice. Don't tidy them up.

### Highlighter emphasis

`<mark>` element with a yellow marker background. One color only.

```css
mark { background: linear-gradient(transparent 55%, var(--highlighter) 55%);
       color: inherit; padding: 0 2px; }
```

Yellow stripe across the lower half of the text — reads as if hand-marked. Use sparingly (≤ 4 times in a 1000-word article).

### Header lockup with date stamp

The masthead reads like a stamped notebook entry:

```html
<header class="masthead">
  <span class="logo">FIELD NOTES</span>
  <span class="dateline">VOL. 3 · ENTRY 14 · 2026-02-14</span>
</header>
```

```css
.masthead { display: flex; justify-content: space-between; align-items: baseline;
            padding: 24px 6vw; border-bottom: 1px dashed var(--rule); }
.masthead .logo { font: 700 14px/1 var(--font-display); letter-spacing: 0.18em; }
.masthead .dateline { font: 12px/1 var(--font-body); color: var(--muted); }
```

Dashed border, not solid. The dash is the notebook's signature divider.

### Section ornament (between movements)

A short ruled tear-line, centered.

```css
hr.tear { border: none; text-align: center; margin: 48px 0; color: var(--muted); }
hr.tear::before { content: "— § —"; letter-spacing: 0.4em; font: 12px/1 var(--font-body); }
```

---

## Concrete examples

### Example 1 — a research field-notes article "What broke at 47°C"

- **Masthead:** `FIELD NOTES` on left, `VOL. 3 · ENTRY 14 · 2026-02-14` on right, dashed underline.
- **Title:** 36px IBM Plex Sans Bold, all caps, letter-spaced. "WHAT BROKE AT 47°C — A NOTEBOOK FROM THE OVEN-LAB."
- **Byline:** "by *Sam Cho · oven-lab*", muted, mono, mid-dot. 14px.
- **Lede paragraph:** 17px mono body, no italic. States the question: "We ran the sensor pack at temperatures 25 → 60°C in 5° steps. Three units failed at 47°C; one at 53°C. The notebook is below."
- **Marginalia at the third paragraph** (left margin, handwriting font, tilted -1.4°): "First failure: 09:42. Coffee was cold."
- **Inline SVG sketch (Fig. 1):** the temperature-drift curve drawn as a single path with start and end dots labeled in handwriting.
- **Body section "Observation":** four mono paragraphs, one `<mark>` highlighter on a load-bearing sentence.
- **Marginalia in margin:** "→ Re-check thermal paste, batch 0224. Could be the seam."
- **Inline SVG sketch (Fig. 2):** a small block diagram of the sensor-housing seam.
- **Section tear `— § —`** between Observation and Hypothesis.
- **Hypothesis section:** three paragraphs, one footnote ref.
- **Footnotes:** two entries with `↩` back-links, in mono at 13px.
- **Colophon:** "Set in IBM Plex Mono on kraft. February 2026."

That's the full kit. Two sketches, two margin notes, one highlighter, one tear, one footnote. The article reads as a working document.

### Example 2 — minimum file skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Field Notes — Vol. 3 / Entry 14</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@400;700&family=Caveat:wght@400;700&display=swap" rel="stylesheet">
  <style>
    /* TOKENS — paste the block from above */
    :root { --bg:#E8DCC0; --paper:#F0E6CC; --ink:#2B2418; --muted:#7A6F5C; --rule:#C8B89A;
            --highlighter:#F2D85C; --dot:rgba(43,36,24,.08);
            --font-display:"IBM Plex Sans",sans-serif; --font-body:"IBM Plex Mono",monospace;
            --font-hand:"Caveat",cursive; }
    body { margin:0; background:
            radial-gradient(circle, var(--dot) 1px, transparent 1px) 0 0/24px 24px, var(--bg);
            color:var(--ink); font:15px/1.65 var(--font-body); }
    .masthead { display:flex; justify-content:space-between; padding:24px 6vw;
                border-bottom:1px dashed var(--rule); }
    .masthead .logo { font:700 14px/1 var(--font-display); letter-spacing:.18em; }
    .masthead .dateline { font:12px/1 var(--font-body); color:var(--muted); }
    .body { position:relative; max-width:62ch; margin:48px auto 0 22vw; padding:0 24px; }
    h1 { font:700 36px/1.1 var(--font-display); letter-spacing:.04em; text-transform:uppercase; margin:0 0 24px; }
    .byline { font-size:14px; color:var(--muted); margin:0 0 32px; }
    .margin-note { position:absolute; left:-22vw; max-width:18vw;
                   font-family:var(--font-hand); font-size:17px; line-height:1.3;
                   color:var(--muted); transform:rotate(-1.4deg); }
    mark { background:linear-gradient(transparent 55%, var(--highlighter) 55%); padding:0 2px; }
    hr.tear { border:none; text-align:center; margin:48px 0; }
    hr.tear::before { content:"— § —"; letter-spacing:.4em; font:12px/1 var(--font-body); color:var(--muted); }
    @media (max-width:1000px) {
      .body { margin:48px auto; }
      .margin-note { position:static; transform:none; display:block;
                     margin:16px 0; padding-left:16px; border-left:2px solid var(--rule); }
    }
  </style>
</head>
<body>
  <header class="masthead" data-cx-id="masthead">
    <span class="logo">FIELD NOTES</span>
    <span class="dateline">VOL. 3 · ENTRY 14 · 2026-02-14</span>
  </header>
  <article class="body" data-cx-id="entry">
    <h1>What broke at 47°C.</h1>
    <p class="byline">by <i>Sam Cho</i> · oven-lab</p>
    <p>We ran the sensor pack at temperatures 25 → 60°C in 5° steps…</p>
    <aside class="margin-note">First failure: 09:42. Coffee was cold.</aside>
    <!-- … rest of the entry … -->
  </article>
</body>
</html>
```

---

## Anti-patterns

- **Bright accent colors.** No teal, no orange, no electric green. One ink, one highlighter yellow, the kraft is the warmth. Anything else snaps the notebook frame.
- **Stock photos inline.** Field notes don't have stock photos. Hand-drawn SVG or nothing.
- **Marginalia in panels.** A bordered box on the side is a sidebar, not a margin note. The margin note has no border — it floats in the left margin in handwriting.
- **Serif body.** Mono is the voice. A serif body turns this into an article-layout piece in beige clothes.
- **Dot grid at 16px or 32px.** 24px is the spacing — small enough to feel like notebook ruling, large enough to not fight the type. Two other sizes you'll instinctively pick are wrong.
- **Highlighter on every other sentence.** ≤ 4 marks in a 1000-word article. More and the page reads like a frantic underliner, not a researcher.
- **Mobile that keeps the absolute marginalia.** Drop to inline-with-rule below 1000px. Absolute positioning at narrow widths overlaps the body and the article becomes unreadable.
