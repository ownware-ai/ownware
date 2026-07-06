---
name: threejs-scene
description: Embed a Three.js 3D scene inside a single-file HTML artifact via CDN — no bundler, no npm. Use when the brief asks for a rotating logo, a 3D hero, a low-poly product preview, a particle field, or any "WebGL feel" element. Skip when a 2D SVG or CSS transform would do the job — Three.js is heavy and only earns its keep when the visual demands real 3D.
trigger: /threejs-scene
---

# Three.js Scene — embedded 3D the artifact way

## Overview

Three.js is a 3D engine that runs in a browser canvas, drawn over WebGL. For this profile, it always ships as a **single self-contained HTML file** — same shape as `artifact` — with the Three.js library pulled from a CDN. No bundler. No `npm install`. No ES modules in the agent's HTML output.

A Three.js scene earns its place when the user explicitly asks for 3D, when a rotating object reinforces brand, or when an interactive 3D demo is the point of the page. Don't reach for it when a CSS `transform: rotateY` or an SVG illustration would do.

This skill walks the canonical scene structure and gives a real ~70-line example you can paste, tune, and ship.

---

## Critical Constraints — read these first, every time

1. **One file. CDN-loaded.** Pull from `https://unpkg.com/three@0.160.0/build/three.min.js` (or a pinned later version). Never `import` from `npm`. Never assume a bundler.
2. **Scene budget for a hero embed.** ≤ 3 mesh objects, ≤ 2 lights (one key + one ambient), 60fps target on M1. If you need more than that for "decoration", you're picking the wrong tool.
3. **Use `THREE.BufferGeometry`.** The old `THREE.Geometry` is removed in modern Three. All built-ins (`BoxGeometry`, `IcosahedronGeometry`, etc.) return BufferGeometry already.
4. **Disable shadows for iframe / preview embeds.** `shadowMap` triples GPU cost; the visual lift is invisible at preview chip count. Re-enable only for a full-page hero.
5. **Always handle `resize`.** Listen for `window.resize`, update `camera.aspect`, call `renderer.setSize(w, h)` and `camera.updateProjectionMatrix()`. A scene that doesn't resize looks broken on first window drag.
6. **Honor `prefers-reduced-motion`.** If the media query is `reduce`, render one static frame and skip the animation loop. Spinning objects on a vestibular-sensitive user is a fail.
7. **`devicePixelRatio` cap.** `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`. Without the cap, retina screens render 4× the pixels and crash the frame budget.

---

## The canonical scene structure (memorize)

Every Three.js artifact this profile produces follows this order:

1. **CDN script tag** in `<head>` — pin a Three version.
2. **A `<canvas id="scene">` (or a `<div id="scene">` host)** inside `<body>`.
3. **`renderer`** — `new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })`. `alpha: true` lets the page background show through; drop it if you want a solid backdrop.
4. **`scene`** — `new THREE.Scene()`. Optional `scene.background = new THREE.Color(...)`.
5. **`camera`** — `new THREE.PerspectiveCamera(fov, aspect, near, far)`. FOV 35–50 for product shots, 60–75 for immersive.
6. **Lights** — one `DirectionalLight` (key) + one `AmbientLight` (fill). For hero embeds, that's all you need.
7. **Mesh(es)** — geometry + material → mesh → `scene.add(mesh)`.
8. **Resize handler** — adjusts camera + renderer on window resize.
9. **Animate loop** — `requestAnimationFrame`, mutate, render. Wrap in a `prefers-reduced-motion` check.

---

## Worked example — rotating low-poly icosahedron hero

This is a complete, paste-ready artifact. ~70 lines of JS. Real values.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Three.js hero · low-poly icosahedron</title>
  <script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
  <style>
    :root {
      --bg: #0d1117;
      --fg: #e6edf3;
      --accent: #58a6ff;
    }
    *,*::before,*::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
    .hero { position: relative; min-height: 100vh; display: grid; place-items: center; }
    .hero h1 { font-size: clamp(40px, 6vw, 72px); letter-spacing: -0.02em; text-wrap: balance; margin: 0 0 16px; }
    .hero p  { font-size: 18px; color: #8b949e; max-width: 48ch; text-align: center; margin: 0; }
    #scene { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; }
    .hero-content { position: relative; text-align: center; padding: 24px; }
  </style>
</head>
<body>
  <section class="hero" data-cx-id="hero">
    <canvas id="scene"></canvas>
    <div class="hero-content">
      <h1>Render the impossible.</h1>
      <p>A WebGL hero you can edit in one file.</p>
    </div>
  </section>

  <script>
    (function () {
      const canvas = document.getElementById('scene');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
      camera.position.set(0, 0, 4);

      // Key + ambient lighting — two lights is enough for a hero embed.
      const key = new THREE.DirectionalLight(0xffffff, 1.2);
      key.position.set(3, 5, 4);
      scene.add(key);
      scene.add(new THREE.AmbientLight(0x88aaff, 0.4));

      // Low-poly icosahedron — flat shaded, accent color, slight transparency.
      const geom = new THREE.IcosahedronGeometry(1.1, 0);
      const mat  = new THREE.MeshStandardMaterial({
        color: 0x58a6ff,
        flatShading: true,
        roughness: 0.4,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geom, mat);
      scene.add(mesh);

      // Resize handler — keep aspect honest.
      window.addEventListener('resize', () => {
        const w = window.innerWidth, h = window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });

      // Respect reduced motion.
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      function animate(t) {
        mesh.rotation.x = t * 0.0003;
        mesh.rotation.y = t * 0.0005;
        renderer.render(scene, camera);
        if (!reduce) requestAnimationFrame(animate);
      }

      if (reduce) {
        renderer.render(scene, camera);  // one static frame
      } else {
        requestAnimationFrame(animate);
      }
    })();
  </script>
</body>
</html>
```

That's the whole pattern. ~70 lines of JS, runs at 60fps on M1, hits the iframe preview clean.

---

## Concrete examples — what to swap

### Swap 1 — different shape

Replace `IcosahedronGeometry(1.1, 0)` with:

- `new THREE.TorusKnotGeometry(0.8, 0.25, 100, 16)` → flowing tube knot.
- `new THREE.OctahedronGeometry(1.2, 0)` → diamond-like.
- `new THREE.SphereGeometry(1.0, 32, 16)` → smooth sphere (drop `flatShading`).
- `new THREE.BoxGeometry(1.2, 1.2, 1.2)` → cube.

Each is one line of change.

### Swap 2 — particle field instead of solid mesh

```js
const count = 1500;
const positions = new Float32Array(count * 3);
for (let i = 0; i < count * 3; i++) positions[i] = (Math.random() - 0.5) * 10;
const geom = new THREE.BufferGeometry();
geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const mat  = new THREE.PointsMaterial({ color: 0x58a6ff, size: 0.02, transparent: true, opacity: 0.6 });
scene.add(new THREE.Points(geom, mat));
```

1500 particles, no shadows, ~2ms per frame on M1.

### Swap 3 — pointer-driven rotation (cheap interactivity)

```js
const target = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  target.x = (e.clientX / window.innerWidth  - 0.5) * 0.6;
  target.y = (e.clientY / window.innerHeight - 0.5) * 0.6;
});
// inside animate():
mesh.rotation.y += (target.x - mesh.rotation.y) * 0.05;
mesh.rotation.x += (target.y - mesh.rotation.x) * 0.05;
```

Smooth follow, no library needed. The lerp factor `0.05` is the smoothing — lower = lazier.

---

## Anti-patterns

- **Reaching for OrbitControls / dat.gui for a hero scene.** Stop. They're for editor UIs, not heroes. Use pointer-follow rotation (Swap 3) — 6 lines.
- **`shadowMap.enabled = true` on a small embed.** Stop. Shadow cost outweighs the visual gain at iframe chip count. Re-enable only for full-page heroes on desktop.
- **Re-creating geometries inside `animate()`.** Stop. Build once outside the loop; mutate `rotation`, `position`, `material.color`. Allocating in the hot path tanks frame rate.
- **`renderer.setPixelRatio(window.devicePixelRatio)` without cap.** Stop. Retina + 4K → 4× the pixels. Cap at 2.
- **`THREE.Geometry` (no Buffer).** Stop. Removed in modern Three. Use `BufferGeometry`.
- **Ignoring `prefers-reduced-motion`.** Stop. Spinning UI on vestibular-sensitive users is a fail.
- **Loading three.js from `unpkg.com/three` (unpinned).** Stop. Pin the version (`three@0.160.0`). Otherwise a future Three release silently breaks the artifact.
- **Mixing `module` and `umd` builds.** The CDN `build/three.min.js` is UMD — global `THREE` is fine. Don't `import` in the agent's HTML.
