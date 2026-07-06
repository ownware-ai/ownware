---
name: algorithmic-art
description: 'Generative art in a single HTML file via p5.js (preferred) or canvas2D. Patterns: Perlin noise fields, particle systems, recursive subdivisions, flow fields, voronoi tessellations. Seeded randomness so every render is reproducible. Use for procedural cover art, hero backgrounds, generative posters, frame studies. Skip when a static SVG or photograph would do the job — p5.js is heavy and only earns its weight when the art is genuinely procedural.'
trigger: /algorithmic-art
---

# Algorithmic Art — generative pieces, one file

## Overview

Generative art is procedure as design. You write the rules — a noise field, a flow line, a recursive split — and the canvas renders the result. Done well it produces work that feels both inevitable (it followed the rules) and surprising (the rules made something the rules-author didn''t fully picture).

Output is always a single self-contained HTML file with p5.js loaded from CDN. The piece must be reproducible — seed the RNG. The piece must respect reduced-motion. The piece must hand off cleanly to the artifact discipline.

---

## Critical Constraints

1. **One file, p5.js via CDN.** `<script src="https://cdn.jsdelivr.net/npm/p5@1.11.4/lib/p5.min.js"></script>`. No npm install. No bundler. canvas2D is fine if the piece is simple and doesn''t need p5''s helpers.
2. **Seeded randomness — always.** `randomSeed(seed)` and `noiseSeed(seed)` at the top of `setup()`. The seed is a constant in the file (e.g. `const SEED = 42`). Two reloads must produce the same image. Unseeded generative art is gambling, not design.
3. **`prefers-reduced-motion`.** If the user has reduced motion enabled, render one static frame and call `noLoop()`. Endless animation is a fail for motion-sensitive users.
4. **Cap pixel density.** `pixelDensity(Math.min(window.devicePixelRatio, 2))`. Retina + 4K with no cap will tank frame rate.
5. **Cap particle count for the medium.** Hero embed: ≤ 800 particles. Full-page background: ≤ 3000. Static poster: anything, since it''s one frame. If frame rate dips below 30fps on M1, halve the count.
6. **One color palette per piece.** A background, a body color, an accent. Three colors max. Multicolor generative art reads as visual noise; restraint reads as design.
7. **`data-cx-id="canvas"` on the canvas host.** Per `/artifact`. Lets edits target the canvas region surgically.

---

## The five patterns — which to reach for

### 1. Perlin noise flow field

A grid of arrows whose angles come from 2D Perlin noise. Particles released into the grid trace the arrow flow, producing organic line-flow. Use for soft, organic, "wind across a field" looks. The default move for cover art.

### 2. Particle system

Hundreds to thousands of particles each with position + velocity + lifespan. Rendered as faint dots that fade. Use for starfields, ember showers, sparse-organic backdrops.

### 3. Recursive subdivision

A rectangle splits into two; each child splits; each grandchild splits. Vary split direction by noise. Use for Mondrian-style abstracts and architectural-feeling compositions.

### 4. Voronoi tessellation

Seed points divide the plane into cells where each cell contains the area closest to its seed. Use for cellular, organic-but-precise pattern.

### 5. Recursive trees / L-systems

A starting line branches at angles, each branch branches. Iteration 4–6 reads as design; 10+ reads as photography. Pick ONE pattern per piece — combining two usually muddles the result.

---

## The canonical artifact — a noise-driven flow field

This is paste-ready. ~40 lines of p5.js. Real values.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Generative cover · flow field</title>
  <script src="https://cdn.jsdelivr.net/npm/p5@1.11.4/lib/p5.min.js"></script>
  <style>
    :root {
      --bg: #0e1218;
      --ink: #f5f1e6;
      --accent: #d97757;
      --font-display: "Inter Tight", "Inter", system-ui, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-display); display: grid; place-items: center; min-height: 100vh; }
    main { position: relative; width: min(96vw, 1080px); aspect-ratio: 3 / 2; }
    canvas { width: 100% !important; height: 100% !important; display: block; }
    h1 { position: absolute; left: 32px; bottom: 32px; margin: 0; font: 600 28px/1.1 var(--font-display); letter-spacing: -0.01em; color: var(--ink); }
    .kicker { position: absolute; left: 32px; top: 32px; margin: 0; font: 600 11px/1 var(--font-display); letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); opacity: 0.9; }
  </style>
</head>
<body>
  <main data-cx-id="canvas">
    <div class="kicker">GENERATIVE STUDY · 0042</div>
    <h1>Field, after rain.</h1>
  </main>

  <script>
    const SEED = 42;
    const N_PARTICLES = 600;
    const STEP = 1.4;
    const NOISE_SCALE = 0.0035;
    let particles = [];
    let reduce = false;

    function setup() {
      const host = document.querySelector('main');
      const w = host.clientWidth, h = host.clientHeight;
      const c = createCanvas(w, h);
      c.parent(host);
      pixelDensity(Math.min(window.devicePixelRatio, 2));
      randomSeed(SEED);
      noiseSeed(SEED);
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      background('#0e1218');
      stroke(245, 241, 230, 22);  // ink @ low alpha → builds depth over frames
      strokeWeight(1);

      for (let i = 0; i < N_PARTICLES; i++) {
        particles.push({ x: random(width), y: random(height), life: random(100, 280) });
      }
      if (reduce) {
        for (let t = 0; t < 220; t++) tick();
        noLoop();
      }
    }

    function tick() {
      for (const p of particles) {
        const a = noise(p.x * NOISE_SCALE, p.y * NOISE_SCALE) * TWO_PI * 2;
        const nx = p.x + cos(a) * STEP;
        const ny = p.y + sin(a) * STEP;
        line(p.x, p.y, nx, ny);
        p.x = nx; p.y = ny; p.life -= 1;
        if (p.life <= 0 || nx < 0 || nx > width || ny < 0 || ny > height) {
          p.x = random(width); p.y = random(height); p.life = random(100, 280);
        }
      }
    }

    function draw() { tick(); }
  </script>
</body>
</html>
```

Two reloads produce the same image (seed is locked). Reduced motion produces one static frame after 220 iterations. The piece earns its keep with a Mate-Mocha-adjacent palette and one accent for the kicker.

---

## Concrete examples — what to swap

### Swap 1 — different palette

Replace the three CSS variables:

```css
--bg: #f1efea; --ink: #161616; --accent: #c5e803;   /* Ash & Lime */
--bg: #fdf6f3; --ink: #1a1015; --accent: #ff5d8f;   /* Pearl Rose */
--bg: #0a0e1a; --ink: #f5f5f7; --accent: #5ac8fa;   /* Sea Indigo */
```

Also update the `stroke(245, 241, 230, 22)` rgba to match the new `--ink` color (e.g. `stroke(22, 22, 22, 18)` for Ash & Lime — dark ink on light bg).

### Swap 2 — voronoi tessellation instead of flow field

In `setup()`, generate 24 seed points with `random(width)` / `random(height)`. Then `loadPixels()`, iterate over the canvas in 2-pixel steps, for each pixel find the nearest seed by squared distance, and `set(x, y, color(...))` to a hue derived from the seed index. End with `updatePixels()` + `noLoop()`. ~15 lines of JS. Static, re-seedable.

### Swap 3 — recursive subdivision Mondrian (sketch)

In `setup()`, call `divide(0, 0, width, height, 0)` with: each call splits horizontally or vertically at a `random(0.3, 0.7)` ratio; max depth 5; at the leaf, with 25% probability fill the rect with `--accent` or `--ink`, otherwise stroke only at 4px. `noLoop()` after. Produces a Mondrian-flavoured composition; same seed → same image. ~25 lines of JS.

---

## Anti-patterns

- **Unseeded `random()` calls.** Stop. Every reload produces a different image; the user cannot iterate or compare. Always `randomSeed(SEED)` and `noiseSeed(SEED)` at the top of `setup()`.
- **Endless `draw()` with no exit and no reduced-motion check.** Stop. The piece must respect `prefers-reduced-motion: reduce` by rendering one static frame and calling `noLoop()`.
- **Multicolor palettes (5+ hues).** Stop. Three colors max. Generative pieces with many colors read as visual noise, not design.
- **Particle count > 3000 without justification.** Stop. Frame rate dies. If the piece needs more, render to an offscreen buffer once and copy.
- **Re-creating geometry inside `draw()`.** Stop. Build once in `setup()`, mutate in `draw()`. Allocating in the hot loop tanks performance.
- **Reaching for `algorithmic-art` when a static SVG would do.** Stop. p5.js is heavy. If the piece is one logo, one curve, one fixed shape — use inline SVG via `/artifact`.
- **Letting the canvas overflow its host.** Stop. The canvas is sized to the `<main>` host via `createCanvas(host.clientWidth, host.clientHeight)`. If the host resizes, listen for resize and call `resizeCanvas(...)`.
