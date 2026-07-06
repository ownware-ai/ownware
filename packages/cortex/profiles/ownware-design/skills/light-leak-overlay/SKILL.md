---
name: light-leak-overlay
description: 'Visual-effect overlay — film-grain + warm colored-flare layered on a hero, evoking 35mm cinematic warmth. CSS-only (radial gradients + SVG turbulence). Specific values — 8–12% grain opacity, warm cast peak at hsla(30, 80%, 70%, 0.12), drift loop 8–12s. Use for editorial / cinema / narrative landing heroes and video chapter cards. Skip for clean B2B (use artifact + Modern Minimal).'
trigger: /light-leak-overlay
---

# Light-Leak Overlay — 35mm warmth on a hero, in one inline style block

## Overview

A single visual move: layer a warm flare + film-grain texture over a hero image or color field. Done well, it reads as "shot on film"; done badly, it looks like an Instagram filter from 2014. The difference is restraint — two warm hues, low grain opacity, drift slow enough to be subliminal. Pairs with the hero block of an `artifact` or a `video-frames` chapter card; doesn't replace either.

This is a *texture* skill, not a layout skill. It assumes you already have a hero with a headline and a background image (or a deep color field) and you want to add the cinematic patina on top.

---

## Critical Constraints — read these first, every time

1. **Two warm hues max.** One peak flare (warm orange/amber) and one secondary glow (peach or rose). No cool blues, no greens, no purples in the leak — film leaks are warm because film stock is warm.
2. **Grain opacity 8–12% on `mix-blend-mode: overlay`.** Higher and the image goes muddy; lower and the effect disappears. Tune to the underlying image's contrast — darker images take 12%, brighter take 8%.
3. **Peak flare opacity ≤ 0.18.** Use `hsla(30, 80%, 70%, 0.12)` as the default ceiling. Above 0.2 and the hero photo disappears under the flare.
4. **Drift loop 8–12 seconds.** Anything faster reads as a glitch animation. Disable entirely on `prefers-reduced-motion: reduce` — the grain stays, the drift stops.
5. **Two overlay layers, not five.** One radial flare + one grain texture. A third "color wash" layer is the line where this turns into a filter, not a leak.
6. **CSS-only by default; canvas only if the user needs the grain to animate.** Static grain (SVG turbulence as a data URI) is indistinguishable from canvas grain at rest and costs no CPU.
7. **Z-index discipline.** Hero image z-index 0; flare z-index 1; grain z-index 2; headline z-index 3. The text must stay on top with full opacity — never dim the headline to "match the mood".

---

## The technique — one CSS recipe

### Layer 1 — the warm flare (radial gradient, animated drift)

```css
.hero {
  position: relative;
  overflow: hidden;
  background: #1a0d08 url('./hero.jpg') center/cover no-repeat;
}

.hero::before {
  content: "";
  position: absolute; inset: -10%;       /* over-size so drift never reveals an edge */
  background:
    radial-gradient(ellipse 60% 50% at 75% 25%,
      hsla(30, 80%, 70%, 0.12) 0%,        /* peak — warm amber */
      hsla(20, 75%, 65%, 0.06) 35%,       /* mid — peach */
      transparent 60%),
    radial-gradient(ellipse 40% 30% at 20% 80%,
      hsla(15, 70%, 60%, 0.08) 0%,        /* secondary — rose, opposite corner */
      transparent 55%);
  mix-blend-mode: screen;
  animation: leak-drift 11s ease-in-out infinite alternate;
  z-index: 1;
  pointer-events: none;
}

@keyframes leak-drift {
  0%   { transform: translate(0, 0)     scale(1); }
  100% { transform: translate(2%, -1%)  scale(1.04); }
}
```

`screen` blend on warm hues over a dark photo lifts the warm regions without flattening the image. `inset: -10%` ensures the drift never reveals a hard edge.

### Layer 2 — 35mm grain (SVG turbulence as a data URI)

```css
.hero::after {
  content: "";
  position: absolute; inset: 0;
  background-image: url("data:image/svg+xml;utf8,\
    <svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>\
      <filter id='n'>\
        <feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='3'/>\
        <feColorMatrix values='0 0 0 0 1   0 0 0 0 1   0 0 0 0 1   0 0 0 1 0'/>\
      </filter>\
      <rect width='100%' height='100%' filter='url(%23n)'/>\
    </svg>");
  background-size: 200px 200px;
  opacity: 0.10;                          /* 8% bright photos, 12% dark photos */
  mix-blend-mode: overlay;
  z-index: 2;
  pointer-events: none;
}
```

Inline SVG turbulence is the cleanest grain source — no external image, no canvas, no flashing. The `200x200` tile repeats invisibly.

### Layer 3 — reduced-motion fallback

```css
@media (prefers-reduced-motion: reduce) {
  .hero::before { animation: none; }
}
```

Drift stops; flare and grain stay. The mood survives, the vestibular trigger doesn't.

### Headline layer (just to set the z-order)

```css
.hero .copy { position: relative; z-index: 3; color: #f5e9d6; }
```

Headline always on top, full opacity. The leak is texture, not foreground.

---

## Color palettes — pick one

The flare and grain are warm by definition. Vary the *underlying* image's color mood; the leak hues stay in the warm half-circle.

| Mood        | Underlying tone        | Flare peak (hsla)              | Secondary (hsla)              |
|-------------|------------------------|--------------------------------|-------------------------------|
| Golden hour | Brown / sienna `#1a0d08` | `hsla(30, 80%, 70%, 0.12)`     | `hsla(15, 70%, 60%, 0.08)`    |
| Magic hour  | Indigo / plum `#1a0d1f`  | `hsla(20, 75%, 65%, 0.10)`     | `hsla(340, 65%, 60%, 0.06)`   |
| Forest dusk | Deep green `#0a1410`     | `hsla(40, 75%, 65%, 0.10)`     | `hsla(10, 65%, 55%, 0.06)`    |
| Night film  | Near-black `#0a0a0a`     | `hsla(35, 85%, 70%, 0.14)`     | `hsla(20, 70%, 55%, 0.07)`    |

Don't recolor the leak to cool tones — that's not what 35mm light leaks look like physically. If the brand demands cool, the answer is a different texture skill, not this one with the wrong colors.

---

## Concrete examples

### Example 1 — editorial landing hero with the full overlay

```html
<section class="hero" data-cx-id="hero">
  <div class="copy">
    <span class="kicker">CHAPTER I</span>
    <h1>The patience of typography</h1>
    <p>Field notes from twelve months of redrawing the page.</p>
  </div>
</section>

<style>
  .hero { position: relative; height: 100vh; min-height: 720px; overflow: hidden;
          background: #1a0d08 url('./field-notes-hero.jpg') center/cover no-repeat; }
  .hero::before { content:""; position:absolute; inset:-10%;
    background:
      radial-gradient(ellipse 60% 50% at 75% 25%, hsla(30,80%,70%,0.12) 0%, hsla(20,75%,65%,0.06) 35%, transparent 60%),
      radial-gradient(ellipse 40% 30% at 20% 80%, hsla(15,70%,60%,0.08) 0%, transparent 55%);
    mix-blend-mode: screen; animation: leak-drift 11s ease-in-out infinite alternate;
    z-index:1; pointer-events:none; }
  .hero::after { /* grain layer from the recipe above */ }
  .hero .copy { position:relative; z-index:3; color:#f5e9d6; padding: 12vh 8vw; max-width: 760px; }
  .hero .kicker { font: 600 12px/1 ui-monospace, JetBrains Mono, monospace;
                   letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.7; }
  .hero h1 { font: italic 600 6vw/1.05 "Source Serif Pro", Georgia, serif; margin: 16px 0 24px; text-wrap: balance; }
  @keyframes leak-drift { 0%{transform:translate(0,0) scale(1);} 100%{transform:translate(2%,-1%) scale(1.04);} }
  @media (prefers-reduced-motion: reduce) { .hero::before { animation: none; } }
</style>
```

Golden-hour palette, italic serif headline, monospace kicker. Drift 11s; grain 10%.

### Example 2 — chapter card for a video frame (no background photo)

When there's no hero image — a chapter card on a deep color field — the leak does more visual work. Lift the flare opacity slightly (peak to 0.18) and add a third radial pull near the headline.

```css
.frame {
  background: #0a0a0a;
}
.frame::before {
  background:
    radial-gradient(ellipse 70% 55% at 70% 30%, hsla(35,85%,70%,0.18) 0%, hsla(20,70%,55%,0.08) 40%, transparent 65%),
    radial-gradient(ellipse 35% 25% at 30% 75%, hsla(10,65%,55%,0.10) 0%, transparent 55%);
}
```

Same grain layer (12% opacity for near-black field). The headline sits in the bright zone where the flare peaks.

---

## Anti-patterns

- **Cool-blue or purple leak.** Stop. Film leaks are warm because film stock fogs warm under accidental exposure. A cool leak reads as "digital filter", not "shot on film".
- **Five overlay layers.** Stop. Two layers (flare + grain). A "color wash" or "vignette" third layer is the line where you've left "subtle texture" and entered "Instagram preset".
- **Dimming the headline to match the mood.** Stop. The headline stays full opacity. The leak is texture under the message, not a tint over it.
- **Drift loop under 6s or over 14s.** Stop. Under 6s reads as a glitch; over 14s feels broken. 8–12s is the cinematic range.
- **Animated canvas grain when static SVG would do.** Stop. Static grain at 10% opacity is indistinguishable from animated grain at rest scale. Save the CPU.
- **Skipping the `prefers-reduced-motion` fallback.** Stop. Vestibular triggers from slow drift are real. Two extra lines; non-negotiable.
- **Using the leak on a B2B SaaS landing.** Stop. The skill exists for editorial / cinema / narrative — wrong move on a procurement-page hero. Reach for `artifact` + Modern Minimal instead.
