---
name: pixel-orbit-template
description: '8-bit / pixel-art static aesthetic for hero or landing artifacts — NES-adjacent 32-color palette, no anti-aliasing, chunky 4px borders, Press Start 2P / pixel-bitmap type, image-rendering: pixelated. Use when the brief asks for "retro arcade", "8-bit", "NES-style", "pixel-deck", "gameboy". This is the STATIC aesthetic — for animated/video pieces use a video skill. Skip when the brief asks for "modern retro" or "Y2K" — those are different aesthetics with different palettes.'
trigger: /pixel-orbit-template
---

# Pixel Orbit Template — 8-bit static aesthetic

## Overview

Pixel art on the web fails when the browser tries to be helpful: bilinear-smoothing a 16×16 sprite into a blurry watercolor, anti-aliasing a chunky border into a soft line, drop-shadowing the sharp-edged glyph into Photoshop output. This skill is the discipline that keeps pixel-perfect what should stay pixel-perfect.

Three load-bearing moves: a locked 32-color NES-adjacent palette, `image-rendering: pixelated` on every raster element, and a bitmap-style display font (Press Start 2P or a font-face hosted pixel font). The rest is composition.

---

## Critical Constraints

1. **32-color palette, locked.** Pick from the palette below. No `rgba()`, no gradients, no semi-transparent layers, no glow-blur. Each color is one of the 32 values; nothing in between.
2. **`image-rendering: pixelated` on every image, canvas, and SVG.** Without it the browser smooths your art into mush. Apply globally and override-as-needed.
3. **Chunky borders, 4–8px solid.** No `1px solid` — that reads as web-default. Pixel borders are 4–8px and always `solid`. Never `dashed` or `dotted`.
4. **No radius. No shadows. No gradients.** All edges square. All fills flat. The whole point is the pixel grid; rounding or shadowing breaks the grid.
5. **Type: bitmap-style font, with letter-spacing.** Press Start 2P (free, Google Fonts) is the default. Letter-spacing 0.06–0.12em gives the "arcade marquee" feel.
6. **8-px or 16-px grid for spacing.** Padding, margins, gaps all snap to multiples of 8 (or 16 for larger gaps). 14px paddings break the rhythm.
7. **`data-cx-id` anchors per `/artifact`.** This skill produces a normal artifact file — same structure as `/artifact`, different aesthetic discipline.

---

## The 32-color palette (NES-adjacent)

Pick four to eight per piece. Do not mix in non-palette colors.

```css
:root {
  /* Darks  */ --p-black: #0f0f1b; --p-night: #1a1a2e; --p-grape: #2a1a3a; --p-wine: #4a1a30;
  /* Mids   */ --p-blue: #2d4d8a; --p-azure: #3aa1ff; --p-teal: #1faaa1; --p-mint: #5ddd9c; --p-fern: #2a8a3a; --p-olive: #7a8a2a;
  /* Warm   */ --p-amber: #ffb547; --p-orange: #ff7a2a; --p-rust: #c9482a; --p-pink: #ff4d8a; --p-rose: #c93a5a; --p-magenta: #aa3aff;
  /* Lights */ --p-cream: #ffeac8; --p-paper: #f6e6c0; --p-bone: #d0c8a8; --p-stone: #888090; --p-mist: #b0b8c0; --p-sky: #aad4ff;
  /* Accent */ --p-coin: #ffd24d; --p-life: #ff3838;
}
```

24 of the 32 — enough to compose any piece. Add 4–8 more for a specific console reference (Gameboy DMG, NES, SNES, PC-98) if needed, but stay disciplined.

---

## The canonical pixel hero (paste-ready)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ownware · pixel hero</title>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    :root {
      --p-black: #0f0f1b;
      --p-night: #1a1a2e;
      --p-azure: #3aa1ff;
      --p-coin:  #ffd24d;
      --p-cream: #ffeac8;
      --p-life:  #ff3838;
      --p-mint:  #5ddd9c;
      --font-display: "Press Start 2P", "Courier New", monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    img, svg, canvas { image-rendering: pixelated; image-rendering: crisp-edges; }
    html, body { margin: 0; padding: 0; background: var(--p-black); color: var(--p-cream); font-family: var(--font-display); font-size: 14px; line-height: 1.6; }

    .hero { min-height: 100vh; padding: 64px 32px; display: grid; place-items: center; }
    .card {
      background: var(--p-night);
      border: 8px solid var(--p-azure);
      padding: 48px;
      max-width: 720px;
      width: 100%;
      box-shadow: 8px 8px 0 var(--p-black);
      text-align: center;
    }
    .kicker { font-size: 10px; letter-spacing: 0.16em; color: var(--p-coin); margin: 0 0 24px; }
    .title  { font-size: 24px; letter-spacing: 0.06em; line-height: 1.5; margin: 0 0 24px; color: var(--p-cream); }
    .sub    { font-size: 11px; letter-spacing: 0.08em; opacity: 0.85; margin: 0 0 32px; }
    .btn {
      display: inline-block;
      padding: 16px 24px;
      background: var(--p-coin);
      color: var(--p-night);
      border: 4px solid var(--p-cream);
      font: inherit;
      font-size: 12px;
      letter-spacing: 0.1em;
      text-decoration: none;
      text-transform: uppercase;
      box-shadow: 4px 4px 0 var(--p-cream);
    }
    .btn:hover { transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--p-cream); }
  </style>
</head>
<body>
  <section class="hero" data-cx-id="hero">
    <div class="card">
      <p class="kicker">★ OWNWARE · LEVEL 1 ★</p>
      <h1 class="title">YOUR AGENT.<br>YOUR LAPTOP.<br>YOUR RULES.</h1>
      <p class="sub">PRESS START TO BEGIN</p>
      <a class="btn" href="#start">▶ START</a>
    </div>
  </section>
</body>
</html>
```

The piece reads pixel-perfect because every dimension is a multiple of 8 and every color comes from the palette. Add inline sprites with `linear-gradient` rectangles on an 8-px grid (no PNG, no SVG library — just CSS-painted blocks) when the brief calls for them.

---

## Concrete examples — what to swap

### Swap 1 — Gameboy DMG palette (4-color green)

```css
:root {
  --p-darkest: #0f380f;
  --p-dark:    #306230;
  --p-light:   #8bac0f;
  --p-cream:   #9bbc0f;
  --font-display: "Press Start 2P", monospace;
}
body { background: var(--p-cream); color: var(--p-darkest); }
.card { background: var(--p-light); border-color: var(--p-darkest); box-shadow: 8px 8px 0 var(--p-dark); }
.btn { background: var(--p-darkest); color: var(--p-cream); border-color: var(--p-darkest); box-shadow: 4px 4px 0 var(--p-dark); }
```

Two-shade dark + two-shade light, the Gameboy DMG signature. Card and button still 8-grid; only the palette changes.

### Swap 2 — Pixel-art sprite via `box-shadow` painter

For a richer sprite, use `box-shadow` as a per-pixel painter: a `1px × 1px` element with one shadow per "pixel" (`Xpx Ypx 0 <color>`), then `transform: scale(8)` to blow it up. Combined with `image-rendering: pixelated`, the scale stays crisp. Use sparingly — a single sprite is fine; a whole scene of these is painful to maintain. Prefer SVG with `shape-rendering: crispEdges` for anything > 16×16.

### Swap 3 — Font fallback (no Google Fonts)

If external fonts aren''t allowed, stack `"Press Start 2P", "VT323", "Courier New", ui-monospace, monospace`. VT323 is a similar arcade-bitmap feel; `Courier New` is a degraded fallback that still reads chunky.

---

## Anti-patterns

- **Anti-aliased text or sprites.** Stop. If the user has a PNG sprite, add `image-rendering: pixelated;` to it. Without it the browser bilinear-smooths the art into Photoshop mush.
- **`border-radius` anywhere.** Stop. Pixel art is square edges. Even 2px radius destroys the pixel feel.
- **Drop-shadows with blur.** Stop. The "shadow" is a solid color offset by 4–8px on the corner (`box-shadow: 8px 8px 0 var(--p-black)`), never a soft Gaussian blur.
- **Gradients of any kind.** Stop. Pixel art is flat fills. A gradient breaks the 32-color discipline.
- **`em` / `rem` units on layout spacing.** Stop. The grid is 8px integers. Use px so the alignment to the pixel grid stays honest.
- **A "soft retro" palette (pastel y2k).** Stop. That''s a different aesthetic. Pixel-orbit is NES-adjacent saturated colors with hard edges. If the brief asks for pastel/y2k, you picked the wrong skill.
- **Loading a heavy pixel-art library.** Stop. CSS + `image-rendering: pixelated` covers 95% of the cases. A library is overkill for the single hero this skill produces.
