---
name: glitch-title
description: 'A single-frame VFX pattern — RGB-channel-split glitch headline, ±2px cyan/magenta shift with 80–120ms stutter rhythm and a ~12% per-second random trigger. Pure CSS or Canvas2D; no dependencies. Use for cyberpunk hero titles, video transitions, "SIGNAL_LOST" frames, brand-intro stings. Skip when the brief asks for sustained motion across the page — use /motion-library or /motion-timeline. Skip when the design language is editorial or warm — glitch reads as cold-tech.'
trigger: /glitch-title
---

# Glitch Title — RGB-split chromatic stutter

## Overview

A glitch title is one heavy headline plus two ghost layers offset on the red and cyan (or red and blue) channels, with a stutter animation that triggers irregularly. The effect lives in CSS — three `text-shadow` layers and one `@keyframes` — and earns its keep on cyberpunk heroes, video sting frames, "system error" moments, brand intros that want to feel raw.

This is a narrow effect, not a motion system. For sustained UI motion use `/motion-library`; for orchestrated sequences use `/motion-timeline`; for shader-driven generative visuals use `/shader-craft`. The glitch is one trick, done well, on one element.

---

## Critical Constraints — read these first, every time

1. **±2px shifts, not ±10px.** The chromatic aberration that reads as "glitch" is subtle. `transform: translate(-2px, 1px)` on the cyan layer, `translate(2px, -1px)` on the magenta layer. Anything bigger reads as cartoon.
2. **Two ghost layers, not five.** Red+cyan or red+magenta on top of the white-grey body. Three layers is the limit — more and the eye loses the headline.
3. **Stutter rhythm: 80–120ms frames.** A glitch beat is a few frames of offset, a few frames at rest. CSS keyframes at 0%, 20%, 22%, 40%, 42%, … with the offset state held for 2% of the cycle (≈ 80ms in a 4s loop).
4. **Don't loop continuously.** A glitch on every frame reads as broken hardware. The right rhythm is "mostly clean, occasional 100ms blip." Trigger with a JS interval at roughly 12% probability per second, OR with a CSS keyframe that spends 90% of the cycle clean.
5. **Honor `prefers-reduced-motion`.** Fall back to a static chromatic split — show the offset ghost layers as a still effect, kill the animation.
6. **Single-color core, two-color ghosts.** Body text is one foreground (white-ish on dark, near-black on light). The ghosts are cyan/magenta or red/cyan — the two complementary pairs the eye reads as "RGB monitor split."
7. **No SVG `feDisplacement` for the base effect.** Defer to plain `text-shadow` + transform. Reserve SVG filter for the rare "heavy corruption" peak.

---

## Concrete examples — two full patterns

### Example 1 — Pure-CSS glitch hero (no JS)

A 64px headline that glitches twice per cycle of a 4-second loop. The `text-shadow` carries the two offset color ghosts; the `@keyframes` shifts the whole title for 100ms at a time.

```html
<style>
  :root { --bg: #07080a; --fg: #f3f5f7; --c1: #00f0ff; --c2: #ff2bd6; }
  body { margin: 0; min-height: 100vh; background: var(--bg); display: grid; place-items: center; font-family: "Space Grotesk", "Inter Tight", system-ui, sans-serif; }
  .glitch {
    position: relative;
    font-size: clamp(40px, 7vw, 96px);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--fg);
    text-shadow:
      -2px  1px 0 var(--c1),
       2px -1px 0 var(--c2);
    animation: glitch-shift 4s steps(60) infinite;
  }
  /* Stutter — clean for most of the cycle, two ~100ms blips. */
  @keyframes glitch-shift {
    0%, 18%, 22%, 50%, 54%, 100% { transform: translate(0, 0); }
    19%, 20%, 21%                 { transform: translate(-2px, 1px); }
    51%, 52%, 53%                 { transform: translate(2px, -1px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .glitch { animation: none; }   /* keep the static chromatic split */
  }
</style>
<h1 class="glitch" data-cx-id="hero">SIGNAL_LOST</h1>
```

The `text-shadow` is always on — that's the static chromatic split (also what reduced-motion users see). The `@keyframes` only moves the title for ~3 keyframe-steps out of 60 (5% of the loop), twice per cycle — that's the "occasional blip" feel. `steps(60)` makes the motion jump frame-by-frame instead of interpolating; without it the glitch reads as smooth wobble, which is the wrong effect.

### Example 2 — JS-triggered glitch (probabilistic, with rare "heavy" frame)

When the headline should mostly be calm but glitch hard at random intervals — for a video sting or a brand-intro keyframe. ~12% probability per second of triggering. Every ~5th trigger is "heavy" (longer + larger offset).

```html
<style>
  :root { --bg: #07080a; --fg: #f3f5f7; --c1: #00f0ff; --c2: #ff2bd6; }
  body { margin: 0; min-height: 100vh; background: var(--bg); display: grid; place-items: center; font-family: "JetBrains Mono", ui-monospace, monospace; }
  .glitch-title {
    position: relative;
    font-size: clamp(40px, 7vw, 96px);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--fg);
    text-shadow:
      -2px  1px 0 var(--c1),
       2px -1px 0 var(--c2);
    transition: transform 30ms linear;
  }
  .glitch-title.is-glitching {
    transform: translate(var(--gx, -2px), var(--gy, 1px));
  }
  .glitch-title.is-heavy {
    text-shadow:
      -5px  2px 0 var(--c1),
       5px -2px 0 var(--c2),
       0 0 12px rgba(255, 43, 214, 0.4);
  }
</style>
<h1 class="glitch-title" data-cx-id="hero">SIGNAL_LOST</h1>
<script>
  (function () {
    const el = document.querySelector('.glitch-title');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let heavyCounter = 0;
    setInterval(() => {
      if (Math.random() > 0.12) return;            // ~12% chance per second
      const heavy = (++heavyCounter % 5 === 0);    // every 5th glitch is heavy
      const dx = (Math.random() * 4 - 2).toFixed(1);
      const dy = (Math.random() * 2 - 1).toFixed(1);
      el.style.setProperty('--gx', dx + 'px');
      el.style.setProperty('--gy', dy + 'px');
      el.classList.add('is-glitching');
      if (heavy) el.classList.add('is-heavy');
      const dur = heavy ? 180 : 90;
      setTimeout(() => {
        el.classList.remove('is-glitching', 'is-heavy');
      }, dur);
    }, 1000);
  })();
</script>
```

`Math.random() > 0.12` gives the ~12% per-second probability — feels organic, not metronomic. The `is-heavy` modifier bumps the ghost offset from ±2px to ±5px and adds a magenta glow — reserve for the every-5th moment so the eye registers it as an event. `dur: 90ms` is the standard blip; `180ms` for heavy. Going above 250ms reads as a frozen frame, not a glitch.

---

## Anti-patterns

- **Continuous full-cycle glitch animation.** Stop. A headline that glitches for the entire animation loop reads as broken monitor — the user thinks the page failed to render. Most of the cycle must be clean.
- **±10px chromatic shifts.** Stop. That's cartoon, not glitch. ±2px is the band; ±5px reserved for the rare "heavy" moment.
- **More than two ghost layers.** Stop. Three `text-shadow` colors compete; the headline becomes unreadable. Two is the rule.
- **Smooth interpolation (no `steps()`)** Stop. The glitch reads as a wobble. Use `steps(N)` on the animation OR JS-driven class toggles.
- **Forgetting `prefers-reduced-motion`.** Stop. Drop the animation, keep the static chromatic split as the still effect.
- **Coloring the glitch ghosts with arbitrary palette accents.** Stop. The effect only reads correctly with chromatic-aberration colors: red/cyan or magenta/cyan. Using brand red+brand blue breaks the visual metaphor.
- **Using SVG `feDisplacementMap` as the default.** Stop. It's GPU-heavy and slower to author. Reserve for a one-off "heavy corruption" peak; `text-shadow` + transform is the base.
- **Glitching body copy.** Stop. The effect belongs on display sizes (≥48px). On 16px body text it just looks like a font-rendering bug.
