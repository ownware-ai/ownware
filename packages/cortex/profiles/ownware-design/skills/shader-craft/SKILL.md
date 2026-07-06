---
name: shader-craft
description: 'Write GLSL fragment shaders rendered through three.js inside a single-file HTML artifact — animated noise gradients, fluid distortion, mouse-warp backgrounds, procedural grain. Pairs with /threejs-scene for the scene scaffold; this skill owns the GLSL itself (uniforms, varyings, gl_FragColor patterns). Use when the brief asks for a generative/WebGL hero background that feels alive. Skip when a CSS gradient or static SVG would carry the same load — shaders are heavy.'
trigger: /shader-craft
---

# Shader Craft — GLSL the artifact way

## Overview

Where `/threejs-scene` builds the scaffold (renderer, scene, camera, mesh), this skill is about **what runs on the GPU once that scaffold is up.** A `THREE.ShaderMaterial` accepts two strings — a vertex shader and a fragment shader — and the fragment shader is where the picture is made: per-pixel color, per-pixel motion, per-pixel noise. This is the difference between a mesh with a flat blue material and a mesh that ripples with a fluid-like surface that tracks the cursor.

A shader earns its place when the visual is generative (no two frames identical), reactive (mouse-driven, time-driven), or impossible in CSS (true procedural noise, plasma, fluid). Skip it when a `radial-gradient` plus a `filter: blur(80px)` gives the same impression at 0.5% of the GPU cost.

This skill stays inside the single-file artifact discipline — CDN three, inline `<script type="x-shader/x-fragment">`, ~30-50 lines of GLSL. Real values throughout.

---

## Critical Constraints — read these first, every time

1. **Build on `/threejs-scene` scaffolding.** Renderer, scene, camera, mesh — all standard. The shader replaces `MeshStandardMaterial` with `ShaderMaterial`. Don't re-derive the scene structure here.
2. **Pin three.** Same as `/threejs-scene`: `https://unpkg.com/three@0.160.0/build/three.min.js`. Never unpinned.
3. **Use a full-screen plane for backgrounds.** `new THREE.PlaneGeometry(2, 2)` with an `OrthographicCamera` covers the viewport perfectly — no perspective math, no aspect bugs. Reserve the perspective camera for 3D meshes that happen to use a shader.
4. **Pass exactly three baseline uniforms.** `u_time` (seconds since start), `u_resolution` (canvas size in px), `u_mouse` (normalized 0..1). Add more only when the shader actually needs them.
5. **Use `varying vec2 vUv;` for screen-space coordinates.** Set in the vertex shader (`vUv = uv;`), consume in the fragment shader. Normalised 0..1 across the plane. `gl_FragCoord.xy / u_resolution` is the alternative — use whichever reads cleaner per shader.
6. **Honor `prefers-reduced-motion`.** If reduce is set, render ONE frame at `u_time = 0` and skip the `requestAnimationFrame` loop. Plasma at 60Hz on a vestibular-sensitive user is a fail.
7. **`renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`.** Same cap as `/threejs-scene`. Fragment shaders run per pixel; uncapped retina = 4x cost = dropped frames.
8. **No `discard;` in a full-screen background shader.** It triggers an early-out branch and breaks the early-z optimisation on some drivers. For transparency, set `gl_FragColor.a` instead.

---

## Framework — the GLSL building blocks

These four primitives cover 90% of artifact shaders. Memorize the spellings.

| Building block | Purpose | Concrete recipe |
|----------------|---------|-----------------|
| Time-driven motion | "It moves" | `vec2 p = vUv + vec2(cos(u_time*0.3), sin(u_time*0.4)) * 0.05;` |
| Pseudo-noise | Organic texture | `float n = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);` |
| Gradient mix | Two-color blend | `vec3 c = mix(colorA, colorB, smoothstep(0.2, 0.8, vUv.y + sin(u_time)*0.1));` |
| Mouse warp | Cursor-tracked distortion | `vec2 d = uv - u_mouse; uv += normalize(d) * exp(-length(d)*4.0) * 0.04;` |

Two color palettes that read well as shader backgrounds (paste straight into the uniforms):

- **Inky cobalt** — `colorA = vec3(0.04, 0.06, 0.13)` (deep navy), `colorB = vec3(0.18, 0.43, 0.92)` (electric blue).
- **Terracotta dusk** — `colorA = vec3(0.10, 0.05, 0.08)` (charred brown), `colorB = vec3(0.79, 0.39, 0.26)` (warm terracotta).

---

## Concrete examples — two full patterns

### Example 1 — Animated noise-mesh hero background (~30 lines of GLSL)

Full-screen plane, orthographic camera, time-driven noise blended into a cobalt-to-blue gradient. The whole thing is one HTML file.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Shader hero · noise mesh</title>
  <script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
  <style>
    body { margin: 0; background: #04060d; overflow: hidden; }
    canvas { display: block; }
    .hero-content { position: fixed; inset: 0; display: grid; place-items: center; color: #fff; text-align: center; pointer-events: none; }
    .hero-content h1 { font: 700 clamp(40px, 7vw, 96px)/1.05 system-ui, sans-serif; letter-spacing: -0.02em; max-width: 18ch; text-wrap: balance; }
  </style>
</head>
<body>
  <canvas id="scene"></canvas>
  <div class="hero-content"><h1>Render the impossible.</h1></div>

  <script id="vert" type="x-shader/x-vertex">
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  </script>
  <script id="frag" type="x-shader/x-fragment">
    precision highp float;
    uniform float u_time;
    uniform vec2  u_resolution;
    uniform vec2  u_mouse;
    varying vec2  vUv;

    // 2D value noise — cheap, smooth, good enough for backgrounds.
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float a = hash(i), b = hash(i + vec2(1, 0));
      float c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }

    void main() {
      vec2 uv = vUv;
      // Slow drift in two directions, plus a gentle mouse-warp.
      vec2 p = uv * 3.0 + vec2(u_time * 0.05, u_time * 0.07);
      p += (u_mouse - 0.5) * 0.6;

      // Layered noise (fractal) — three octaves is enough at this scale.
      float n = 0.0;
      n += noise(p) * 0.55;
      n += noise(p * 2.1) * 0.30;
      n += noise(p * 4.3) * 0.15;

      vec3 colorA = vec3(0.04, 0.06, 0.13);   // deep navy
      vec3 colorB = vec3(0.18, 0.43, 0.92);   // electric blue
      vec3 col = mix(colorA, colorB, smoothstep(0.30, 0.85, n));

      // Subtle vignette to anchor center.
      float v = 1.0 - smoothstep(0.55, 1.10, length(uv - 0.5));
      col *= mix(0.65, 1.0, v);

      gl_FragColor = vec4(col, 1.0);
    }
  </script>

  <script>
    (function () {
      const canvas = document.getElementById('scene');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      const uniforms = {
        u_time:       { value: 0 },
        u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        u_mouse:      { value: new THREE.Vector2(0.5, 0.5) },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader:   document.getElementById('vert').textContent,
        fragmentShader: document.getElementById('frag').textContent,
        uniforms,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      scene.add(mesh);

      window.addEventListener('pointermove', (e) => {
        uniforms.u_mouse.value.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
      });
      window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        uniforms.u_resolution.value.set(window.innerWidth, window.innerHeight);
      });

      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const start = performance.now();
      function frame(t) {
        uniforms.u_time.value = (t - start) / 1000;
        renderer.render(scene, camera);
        if (!reduce) requestAnimationFrame(frame);
      }
      if (reduce) { uniforms.u_time.value = 0; renderer.render(scene, camera); }
      else requestAnimationFrame(frame);
    })();
  </script>
</body>
</html>
```

That's the whole pattern. `OrthographicCamera(-1, 1, 1, -1, 0, 1)` + `PlaneGeometry(2, 2)` = a quad that fills the screen exactly. The fragment shader runs once per pixel per frame, drifting through value-noise and blending two colors.

### Example 2 — Mouse-warp shader swap-in (terracotta dusk)

Take the same scaffold and swap the fragment shader to a cursor-tracked warp on a warm palette. Same scaffold, different feel.

```glsl
precision highp float;
uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
varying vec2  vUv;

void main() {
  vec2 uv = vUv;

  // Radial warp toward the cursor — strongest at the cursor, decaying outward.
  vec2 d = uv - u_mouse;
  float falloff = exp(-length(d) * 5.5);
  uv += normalize(d + 0.0001) * falloff * 0.06;

  // Vertical drift over time.
  uv.y += sin(u_time * 0.5 + uv.x * 4.0) * 0.02;

  // Two-color soft gradient on the warped uv.
  vec3 colorA = vec3(0.10, 0.05, 0.08);  // charred brown
  vec3 colorB = vec3(0.79, 0.39, 0.26);  // warm terracotta
  float g = smoothstep(0.1, 0.9, uv.y + sin(uv.x * 3.0 + u_time * 0.3) * 0.08);
  vec3 col = mix(colorA, colorB, g);

  // Soft grain.
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.025;

  gl_FragColor = vec4(col, 1.0);
}
```

`exp(-length(d) * 5.5)` is the falloff — higher constant = tighter warp around the cursor; lower = broader pull. `0.06` is the warp magnitude — keep it below `0.10` or the page feels seasick. The grain term is `±0.0125` per pixel; without it the gradient bands visibly. Drop the same uniforms in from Example 1; only the fragment string changes.

---

## Anti-patterns

- **Per-frame `mat.dispose()` and `new ShaderMaterial(...)`.** Stop. The material is built once. Mutate `uniforms.u_time.value`, not the material itself.
- **`#define PI 3.14159265` in every shader.** Stop. WebGL 1 GLSL already has `radians()`, `degrees()`, `sin`, `cos` — use the built-ins. The constant is fine when you actually need PI, but don't litter.
- **Bumping `u_resolution` in the loop instead of on resize.** Stop. Resolution only changes on resize. Updating every frame burns CPU for nothing.
- **`gl_FragColor = vec4(noise(uv), noise(uv), noise(uv), 1.0);`** Stop. Three noise calls per pixel for one grayscale value is 3x cost. Compute once: `float n = noise(uv); gl_FragColor = vec4(n, n, n, 1.0);`.
- **Animating heavy raymarched scenes for backgrounds.** Stop. Raymarching SDFs is great for centerpiece visuals — too heavy for hero backgrounds where the shader is decoration behind text. Stick to 2D noise + gradient + warp.
- **Skipping `precision highp float;`.** Stop. On mobile GPUs the default is `mediump` and banding shows up fast. One line at the top of every fragment shader.
- **Loading three's full module ESM build (`three.module.js`) instead of `three.min.js`.** Stop. UMD `three.min.js` exposes `THREE` globally and works without bundler ceremony.
- **Forgetting the `prefers-reduced-motion` static-frame fallback.** Stop. Render one frame at `u_time = 0` and exit the loop.
