---
name: liquid-bg-hero
description: 'Visual-effect — liquid / fluid backdrop for a hero block. Two implementations: CSS-only multi-layer radial-gradient morph (default) or three.js fragment-shader fluid (high-end). The CSS frame always ships as the prefers-reduced-motion + shader-loading fallback. Use for landing hero blocks, video chapter cards, poster headers. Skip for data-dense dashboards (use artifact + Tech Utility).'
trigger: /liquid-bg-hero
---

# Liquid BG Hero — fluid backdrop, two implementations, one fallback

## Overview

A hero block with a slowly-morphing liquid backdrop. The high-end implementation uses a fragment-shader fluid simulation via three.js; the low-end implementation is multi-layer animated radial gradients in pure CSS. Both ship in the same artifact; the CSS fallback runs on `prefers-reduced-motion`, on devices without WebGL, and as the static frame when the shader is still loading.

Pairs with `/threejs-scene` if you go the shader route. Lives inside the hero region of an `artifact` — doesn't replace the artifact structure.

Two correct answers depending on the budget: ship the CSS-only version if you want speed and zero risk; ship the shader version if the hero is the headline visual moment of the page and a 200KB CDN load is acceptable.

---

## Critical Constraints — read these first, every time

1. **Four hues maximum.** Multi-color rainbows look like AI-generated stock. Pick a palette (Solar Peach / Ocean Aqua / Aurora Violet / Forest Mint) and stay inside it.
2. **The CSS fallback is mandatory.** Even if you ship the shader, the static gradient frame must render correctly on first paint and on `prefers-reduced-motion`. Never leave the user staring at a black screen for 800ms of shader compile.
3. **Headline z-index 3, fluid layer z-index 0–1, optional grain z-index 2.** Headline always full opacity; never tint the headline to match the fluid.
4. **`mix-blend-mode: difference` on the headline** when the fluid is high-contrast. Difference makes the text adapt to whatever color is under it — readable across the whole morph cycle.
5. **Animation cycle 8–14 seconds.** Faster reads as a screensaver; slower feels frozen. 11s is the default cycle length; vary by ±2s across the 3–5 gradient layers so they drift out of phase.
6. **Disable shader on `prefers-reduced-motion`.** Compile + run cost is a vestibular trigger; the CSS fallback handles the case.
7. **CDN-pinned three.js.** If you use the shader route, pin to `three@0.160.0` (or the version `/threejs-scene` uses). Don't `<script src="https://unpkg.com/three">` unpinned — the API changes between minor versions.

---

## Implementation 1 — CSS multi-layer radial morph (default, recommended)

Five radial gradients, each on its own keyframe with a different period, layered with `mix-blend-mode: screen`. The result is a fluid feel without a single line of JS.

```html
<section class="hero" data-cx-id="hero">
  <div class="copy">
    <h1>One conversation can move a quarter.</h1>
    <p>Acme — the operations OS for fast-moving sales teams.</p>
  </div>
</section>

<style>
  :root {
    /* Aurora Violet palette */
    --liq-1: #a78bfa;
    --liq-2: #7c5cff;
    --liq-3: #6366f1;
    --liq-4: #1e1b4b;
    --paper: #fafaf8;
  }

  .hero {
    position: relative;
    height: 100vh; min-height: 720px;
    overflow: hidden;
    background: var(--liq-4);
    isolation: isolate;
  }

  .hero::before, .hero::after,
  .hero .blob-c, .hero .blob-d, .hero .blob-e {
    content: ""; position: absolute; inset: -20%;
    pointer-events: none;
    mix-blend-mode: screen;
    filter: blur(80px);
  }

  .hero::before {
    background: radial-gradient(circle at 30% 40%, var(--liq-1) 0%, transparent 50%);
    animation: drift-a 11s ease-in-out infinite alternate;
  }
  .hero::after {
    background: radial-gradient(circle at 70% 60%, var(--liq-2) 0%, transparent 55%);
    animation: drift-b 13s ease-in-out infinite alternate;
  }
  .hero .blob-c {
    background: radial-gradient(circle at 50% 30%, var(--liq-3) 0%, transparent 45%);
    animation: drift-c 9s ease-in-out infinite alternate;
  }
  .hero .blob-d {
    background: radial-gradient(circle at 80% 20%, var(--liq-1) 0%, transparent 40%);
    animation: drift-d 12s ease-in-out infinite alternate;
  }
  .hero .blob-e {
    background: radial-gradient(circle at 20% 80%, var(--liq-2) 0%, transparent 50%);
    animation: drift-e 10s ease-in-out infinite alternate;
  }

  @keyframes drift-a { to { transform: translate(8%, 6%)  scale(1.15); } }
  @keyframes drift-b { to { transform: translate(-6%, -8%) scale(1.2);  } }
  @keyframes drift-c { to { transform: translate(4%, -10%) scale(1.1);  } }
  @keyframes drift-d { to { transform: translate(-10%, 4%) scale(1.25); } }
  @keyframes drift-e { to { transform: translate(6%, 8%)   scale(1.18); } }

  .hero .copy {
    position: relative; z-index: 3;
    padding: 14vh 8vw; max-width: 880px;
    color: var(--paper);
    mix-blend-mode: difference;
  }
  .hero h1 {
    font: 700 6vw/1.05 "Inter Tight", "Inter", system-ui, sans-serif;
    letter-spacing: -0.02em; text-wrap: balance; margin: 0 0 24px;
  }
  .hero p { font-size: 22px; line-height: 1.5; max-width: 540px; opacity: 0.9; }

  @media (prefers-reduced-motion: reduce) {
    .hero::before, .hero::after, .hero .blob-c, .hero .blob-d, .hero .blob-e {
      animation: none;
    }
  }
</style>
```

Markup: the `<section>` plus three extra `<div class="blob-*">` (since `::before` / `::after` only give two pseudo-elements). All blobs sit at `inset: -20%` with `blur(80px)` so the edges merge into a continuous fluid surface. Different period lengths (9 / 10 / 11 / 12 / 13s) keep the layers out of phase.

---

## Implementation 2 — three.js fluid shader (high-end, optional)

When the hero is the headline visual moment and a 200KB CDN load is acceptable. Uses a single fragment shader doing domain-warped simplex noise on one full-screen quad.

```html
<section class="hero" data-cx-id="hero">
  <canvas id="liquid-canvas"></canvas>
  <div class="copy">
    <h1>One conversation can move a quarter.</h1>
    <p>Acme — the operations OS for fast-moving sales teams.</p>
  </div>
</section>

<script type="importmap">
  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js" } }
</script>
<script type="module">
  import * as THREE from 'three';

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const canvas = document.getElementById('liquid-canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const uniforms = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2() },
      u_c1: { value: new THREE.Color('#a78bfa') },
      u_c2: { value: new THREE.Color('#7c5cff') },
      u_c3: { value: new THREE.Color('#6366f1') },
      u_c4: { value: new THREE.Color('#1e1b4b') }
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `void main() { gl_Position = vec4(position, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform float u_time;
        uniform vec2 u_resolution;
        uniform vec3 u_c1, u_c2, u_c3, u_c4;

        // Cheap simplex-ish noise
        vec2 hash(vec2 p) {
          p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3)));
          return -1.0 + 2.0*fract(sin(p)*43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          vec2 u = f*f*(3.0-2.0*f);
          return mix(
            mix(dot(hash(i + vec2(0,0)), f - vec2(0,0)),
                dot(hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
            mix(dot(hash(i + vec2(0,1)), f - vec2(0,1)),
                dot(hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
        }

        void main() {
          vec2 uv = gl_FragCoord.xy / u_resolution.xy;
          float t = u_time * 0.08;
          vec2 q = vec2(noise(uv + t), noise(uv + vec2(5.2, 1.3) + t));
          float n = noise(uv * 2.0 + q * 1.5 + t);
          vec3 col = mix(u_c4, u_c1, smoothstep(0.0, 0.4, n));
          col = mix(col, u_c2, smoothstep(0.3, 0.7, n));
          col = mix(col, u_c3, smoothstep(0.6, 0.95, n));
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      uniforms.u_resolution.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    }
    window.addEventListener('resize', resize);
    resize();

    const start = performance.now();
    function tick() {
      uniforms.u_time.value = (performance.now() - start) / 1000;
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    }
    tick();
  }
</script>

<style>
  .hero { position: relative; height: 100vh; min-height: 720px; overflow: hidden;
          background: linear-gradient(135deg, #1e1b4b 0%, #7c5cff 100%); /* CSS fallback frame */ }
  .hero #liquid-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .hero .copy { position: relative; z-index: 3; padding: 14vh 8vw; max-width: 880px;
                color: #fafaf8; mix-blend-mode: difference; }
  .hero h1 { font: 700 6vw/1.05 "Inter Tight", "Inter", system-ui, sans-serif;
             letter-spacing: -0.02em; text-wrap: balance; margin: 0 0 24px; }
  .hero p  { font-size: 22px; line-height: 1.5; max-width: 540px; opacity: 0.9; }

  @media (prefers-reduced-motion: reduce) {
    #liquid-canvas { display: none; }
  }
</style>
```

The `background` on `.hero` is the static fallback the user sees during the 100–400ms shader compile, on `prefers-reduced-motion`, and on devices that fail to acquire a WebGL context. Same color story; lower fidelity.

---

## Palettes — pick one

Four palettes total, copy-paste the hex.

| Name           | c1        | c2        | c3        | c4 (dark) |
|----------------|-----------|-----------|-----------|-----------|
| Solar Peach    | `#ffb18a` | `#f78b4c` | `#d97757` | `#3a1a0d` |
| Ocean Aqua     | `#5ac8fa` | `#0a84ff` | `#1e3a8a` | `#0a1a2f` |
| Aurora Violet  | `#a78bfa` | `#7c5cff` | `#6366f1` | `#1e1b4b` |
| Forest Mint    | `#86efac` | `#34d399` | `#10b981` | `#065f46` |

Don't mix palettes; don't add a fifth hue. The whole point is that the fluid lives inside a narrow color range and stays harmonious as the layers drift.

---

## Concrete examples

### Example 1 — landing hero with CSS-only implementation

Brief: a B2B operational dashboard product wants a single-screen hero with a high-craft visual moment. Risk-tolerance for shader load is low. Ship the CSS-only Aurora Violet version above; headline at 6vw bold Inter Tight, single-sentence subhead, primary CTA below.

### Example 2 — video frame chapter card with shader

Brief: a chapter card for a video frame produced via `/video-frames`. The 1080p still is rendered server-side; the CSS fallback won't run there. Ship the three.js version with the static fallback wired correctly, then capture the still after `requestAnimationFrame` has run ≥3 frames. (See `/video-frames` for the capture step.)

---

## Anti-patterns

- **Rainbow palette / 6+ hues.** Stop. Pick one of the four palettes; stay inside it. Multi-hue fluid reads as AI-generated stock.
- **Shipping the shader without the CSS fallback.** Stop. On first paint and on `prefers-reduced-motion`, the hero needs to render. The CSS gradient frame is the safety net.
- **Animation cycle under 6s.** Stop. Under 6s reads as a screensaver. 8–14s is the band.
- **Dimming the headline opacity to "match the fluid".** Stop. Headline stays full opacity. `mix-blend-mode: difference` does the legibility work without you.
- **Loading three.js unpinned.** Stop. Pin to `three@0.160.0` or the version `/threejs-scene` uses. The library renames APIs between minor versions.
- **Using this hero on a data-dense dashboard.** Stop. The fluid eats focus; a dashboard's focus belongs on the data. Reach for `artifact` + Tech Utility or Modern Minimal instead.
- **Forgetting `mix-blend-mode: screen` on the gradient layers.** Stop. Without `screen`, the gradients composite as opaque circles and the fluid effect dies. Screen is what makes the layers feel continuous.
