---
name: open-slide-deck
description: 'Canvas-based deck variant where each slide is a free-composition 1920×1080 canvas — no shared slide-master, no auto-flow grid. Every slide picks its own anchor (top-left, centered, corner-quadrant, full-bleed). Use when the brief is a portfolio, an art-direction deck, a designer-to-designer presentation, or any deck where each page should feel intentionally composed. Skip for sales decks or any deck where 20 slides must feel uniform — that''s plain /deck.'
trigger: /open-slide-deck
---

# Open-Slide Deck — every slide is its own canvas

## Overview

Most decks are a slide-master + content slots. This variant inverts that: each slide is an empty 1920×1080 canvas, and content is placed where the composition demands — not where a template puts it. The discipline is in the constraints (locked palette, locked type scale, single visual hierarchy per slide), not in a uniform layout.

Layer this on top of `/deck` for the 1920×1080 canvas, scaling, keyboard nav, and print stylesheet. This skill adds the type scale, the palette options, and the rules each free-composition slide must still obey.

---

## Critical Constraints

1. **Strict 1920×1080. No overflow.** Each slide must fit. No scrollbars. If content does not fit, split into two slides or scale the content down — never let the canvas overflow.
2. **Type scale in px, locked.** `2xs:18 · xs:22 · sm:28 · md:36 · lg:48 · xl:64 · 2xl:88 · 3xl:120 · 4xl:160 · 5xl:220`. Pick from these only. No "55px because it looks better" — round to the nearest scale step.
3. **Padding from {96, 128, 160}.** Three choices. Pick one per slide based on content density.
4. **One visual hierarchy per slide.** ONE dominant element — a sentence, a number, an image, a question. Never two competing primaries. If you find yourself emphasizing two things, split the slide.
5. **One accent color per deck.** From the palette below. Used for kickers, key numbers, link underlines. Never multiple accents.
6. **`data-cx-id="slide-N-<role>"` on every slide.** Per `/artifact`. Role describes the slide''s function — `cover`, `question`, `image-text`, `data-grid`, `closing`.
7. **Use the user''s real content.** No lorem ipsum. If content is missing, ask before placeholdering.

---

## The four locked palettes

Pick ONE per deck. Do not mix.

1. **Ash & Lime** — `--bg: #f1efea`, `--ink: #161616`, `--accent: #c5e803`. Light, contemporary, design-school.
2. **Sea Indigo** — `--bg: #0a0e1a`, `--ink: #f5f5f7`, `--accent: #5ac8fa`. Dark, tech, late-night-portfolio.
3. **Mate Mocha** — `--bg: #1a1411`, `--ink: #f5e9d6`, `--accent: #d97757`. Dark, warm, editorial-art.
4. **Pearl Rose** — `--bg: #fdf6f3`, `--ink: #1a1015`, `--accent: #ff5d8f`. Light, soft, fashion-adjacent.

Paste into `:root`:

```css
:root {
  --bg: #0a0e1a;
  --ink: #f5f5f7;
  --accent: #5ac8fa;
  --font-display: "Inter Tight", "Inter", -apple-system, system-ui, sans-serif;
  --font-body:    "Inter", -apple-system, system-ui, sans-serif;
  --font-mono:    "JetBrains Mono", ui-monospace, Menlo, monospace;
}
```

---

## The free-composition rules

Each slide picks its own anchor. The anchors are:

- **Top-left** — content hugs `padding: 96px 128px` from top-left. Used for opening declarations.
- **Centered** — content is `place-items: center` on the full canvas. Used for questions, single numbers, manifestos.
- **Corner-quadrant** — content occupies one of the four quadrants, three are empty. Used for portfolio-style "one photo, one caption" spreads.
- **Full-bleed** — content fills the canvas edge-to-edge (image, color block, oversized type). Used for impact moments.
- **Three-column equal** — three vertical zones of equal weight. Used when the slide must show three peers (never two; two equal weights creates indecision).
- **Title + body** — title at top half, body at bottom half, separated by white space (not a rule). Used sparingly.

Pick the anchor that fits the slide''s purpose. The same deck can use four different anchors across ten slides — that''s the point.

---

## Concrete examples

### Example A — 5-slide portfolio deck for a designer

**Palette:** Sea Indigo. **Accent:** `#5ac8fa`. Each slide uses a different anchor on purpose.

```html
<!-- Slide 1: Cover — centered anchor, big single name -->
<section class="slide active" data-cx-id="slide-1-cover" data-screen-label="01 Cover">
  <div class="center">
    <div class="kicker">Selected work · 2024–2026</div>
    <h1 class="t-3xl">Lila Reyes</h1>
    <p class="t-sm muted">Brand systems, type, product surfaces.</p>
  </div>
</section>

<!-- Slide 2: Hero question — full-bleed, oversized single question -->
<section class="slide" data-cx-id="slide-2-question" data-screen-label="02 Question">
  <h2 class="t-4xl pad-96">What does a brand sound like at 2am?</h2>
</section>

<!-- Slide 3: Corner-quadrant — image top-left, caption bottom-right -->
<section class="slide" data-cx-id="slide-3-case-a" data-screen-label="03 Case A">
  <div class="image-block tl"><div class="placeholder">Atlas — case study</div></div>
  <div class="caption br">
    <div class="kicker">01 · Atlas Bank</div>
    <p class="t-md">A reduction of the marque to its single load-bearing curve.</p>
  </div>
</section>

<!-- Slide 4: Three-column — three peer projects -->
<section class="slide" data-cx-id="slide-4-peers" data-screen-label="04 Peers">
  <div class="grid-3">
    <div><div class="kicker">02</div><p class="t-md">Orchard — packaging system.</p></div>
    <div><div class="kicker">03</div><p class="t-md">Helios — type specimen.</p></div>
    <div><div class="kicker">04</div><p class="t-md">Mira — product surface.</p></div>
  </div>
</section>

<!-- Slide 5: Closing — top-left anchor, terse -->
<section class="slide" data-cx-id="slide-5-closing" data-screen-label="05 Closing">
  <div class="tl-anchor">
    <h2 class="t-2xl">Available for selected work, 2026.</h2>
    <a class="t-md accent" href="mailto:lila@example.com">lila@example.com</a>
  </div>
</section>
```

CSS hooks:

```css
.t-3xl { font: 600 120px/1.0 var(--font-display); letter-spacing: -0.025em; }
.t-4xl { font: 600 160px/1.0 var(--font-display); letter-spacing: -0.03em; }
.t-2xl { font: 600 88px/1.05 var(--font-display); letter-spacing: -0.02em; }
.t-md  { font: 400 36px/1.4 var(--font-body); }
.t-sm  { font: 400 28px/1.4 var(--font-body); }
.kicker { font: 600 18px/1 var(--font-body); letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin-bottom: 24px; }
.muted { opacity: 0.6; }
.accent { color: var(--accent); }
.pad-96 { padding: 96px; }
.tl-anchor { position: absolute; top: 128px; left: 128px; max-width: 18ch; }
.center { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 96px; padding: 160px 128px; height: 100%; align-content: center; }
.image-block.tl { position: absolute; top: 96px; left: 96px; width: 1100px; height: 700px; background: #1a2030; }
.caption.br { position: absolute; right: 128px; bottom: 128px; max-width: 32ch; text-align: right; }
.placeholder { display: grid; place-items: center; height: 100%; color: var(--ink); opacity: 0.4; font: 400 22px var(--font-body); }
```

### Example B — Ownware "year one" deck (8 slides)

Direction: Mate Mocha palette. Mix of anchors: cover (centered), three full-bleed quote slides, two corner-quadrant data slides (one big number per slide, one tiny caption opposite corner), one three-column peer-product summary, one closing question (centered). The point is intentional composition variety — the deck reads like a magazine spread, not a Keynote template.

---

## Anti-patterns

- **Two equal text blocks.** Stop. Two equal weights = no hierarchy. Either pick one as primary or split into three columns.
- **A "section" of multiple slides that share the same layout.** Stop. That is `/deck`, not `/open-slide-deck`. If 5 slides want the same template, you picked the wrong skill.
- **Off-scale type sizes.** Stop. 47px is not allowed; round to 48 (`lg`). The scale exists so type rhythms feel composed, not arbitrary.
- **Multi-color accents.** Stop. One accent per deck. A second accent means you need a different palette, not "let me add purple for emphasis."
- **Lucide / Feather icon-library glyphs.** Stop. Inline SVG only, drawn for the deck. Generic icon libraries break the bespoke feel that justifies this skill.
- **Image URLs to the open web.** Stop. Either use the user''s assets (referenced by relative path), or solid color blocks with a label — never `https://images.unsplash.com/...`.
