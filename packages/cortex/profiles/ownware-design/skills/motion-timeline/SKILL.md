---
name: motion-timeline
description: 'Orchestrate multi-step GSAP sequences with gsap.timeline() — chained .to/.from/.fromTo calls, labels, position offsets ("<", ">", "+=0.2"), repeat/yoyo loops, paused for user triggers, and tl.kill() cleanup. Use when the brief asks for a choreographed sequence (logo → title → tagline → CTA → backdrop pulse) instead of one isolated tween. Skip for single tweens — use /motion-library — and for scroll-bound playback — use /scroll-motion. Skip when one CSS @keyframes does the same job.'
trigger: /motion-timeline
---

# Motion Timeline — orchestrated GSAP sequences

## Overview

`gsap.timeline()` is the conductor. Where `/motion-library` covers a single tween (`gsap.to`, `gsap.from`) and `/scroll-motion` binds motion to a scrollbar, this skill is about **sequencing N tweens with deliberate overlap and pacing** — the hero reveal where logo lands, then the title cascades, then the tagline slides up, then the CTA pulses. A timeline is one object you can pause, reverse, seek, restart, or kill cleanly.

A timeline earns its place when there are three or more steps and the timing between them is the design — when "everything lands at once" or "everything fades in linearly" would lose the meaning. For two tweens or fewer, a couple of `gsap.to()` calls with `delay:` is enough; reaching for a timeline is overkill.

This skill assumes the constraints and easing scale from `/motion-library` (`prefers-reduced-motion` guard, pinned CDN, transforms-only). It builds on top.

---

## Critical Constraints — read these first, every time

1. **One timeline per choreographed sequence.** Don't scatter `gsap.to()` calls with manual `delay:` values across the script — that's a hand-rolled timeline with no cleanup, no seek, no reverse. Hoist them into `gsap.timeline()` and chain.
2. **Set `defaults: { ease, duration }` on the timeline.** Every child tween inherits unless overridden. Skipping this means repeating `ease: 'power2.out', duration: 0.6` on every line — verbose and error-prone.
3. **Use the position parameter, not `delay`.** The third arg to `.to()/.from()/.fromTo()` is where it slots on the timeline. `'<'` = start of previous tween. `'>'` = end of previous tween (the default). `'-=0.3'` = 0.3s before the end of the previous. `'+=0.2'` = 0.2s after the end of the previous. `'label'` = at a named label. Inline `delay:` inside a timeline child is a smell.
4. **Name your steps with `.addLabel('step-name')`** when the sequence has more than four beats — makes the timeline readable and lets you jump (`tl.play('step-3')`) without counting.
5. **`paused: true` when the timeline starts on a user trigger.** Modal opens, accordion expands, hover sequences — create the timeline up front, hold it paused, fire `tl.play()` on the event. Re-creating the timeline on every click leaks listeners.
6. **`tl.kill()` on teardown.** If the page swaps a section out (rare in this profile, common in React-via-CDN artifacts), call `tl.kill()` first. Otherwise tweens keep firing on detached DOM and memory grows.
7. **`repeat: -1` + `yoyo: true` is a loop, not a sequence.** Use it for breathing icons, ambient pulses, "live" status dots. A hero reveal does not loop.
8. **Honor `prefers-reduced-motion`.** Same rule as `/motion-library`: wrap the whole init in `if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)`. Static fallback shows the end-state.

---

## Framework — the position parameter cheat sheet

The third argument to every `.to()/.from()/.fromTo()` is the timeline-position string. Memorize these five forms:

| Form | What it means | When to use |
|------|---------------|-------------|
| (omitted) | At the end of the previous tween | The default cascade — each step follows |
| `'<'` | Start of the previous tween | Two things start together, even though one was added first |
| `'<0.2'` | 0.2s after the previous tween's start | Quick overlap — start B while A is still moving |
| `'-=0.3'` | 0.3s before the previous tween's ends | Tight overlap from the tail end |
| `'+=0.4'` | 0.4s of breathing room after the previous | A deliberate pause — used between sections |
| `'label'` | At a named addLabel point | Long sequences where steps are recognisable |

Rhythm rule of thumb: most sequences feel best with `-=0.2` to `-=0.4` between steps — enough overlap to read as cascade, not so much that the eye can't tell things apart. `+=0.2` or longer pauses are for deliberate beats ("logo settles, breath, then title arrives").

---

## Concrete examples — three full patterns

### Example 1 — Five-step hero reveal (logo → title → tagline → CTA → backdrop pulse)

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<section class="hero" data-cx-id="hero">
  <div class="hero-logo">◇</div>
  <h1 class="hero-title">Build something worth shipping.</h1>
  <p class="hero-tagline">An OS for agents that respect the user's machine.</p>
  <a class="hero-cta btn-primary" href="#start">Start free</a>
  <div class="hero-backdrop"></div>
</section>
<style>
  .hero { position: relative; min-height: 100vh; display: grid; place-items: center; gap: 16px; text-align: center; overflow: hidden; }
  .hero-logo { font-size: 64px; color: var(--accent); }
  .hero-title { font-size: clamp(36px, 6vw, 80px); margin: 0; }
  .hero-tagline { font-size: 18px; color: var(--muted); max-width: 48ch; margin: 0; }
  .hero-backdrop { position: absolute; inset: 0; background: radial-gradient(circle at 50% 60%, var(--accent) 0%, transparent 60%); opacity: 0.18; z-index: -1; }
</style>
<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tl = gsap.timeline({ defaults: { ease: 'power3.out', duration: 0.55 } });
    tl.addLabel('start')
      .from('.hero-logo',     { y: 24, opacity: 0, scale: 0.8, ease: 'back.out(1.4)', duration: 0.7 })
      .from('.hero-title',    { y: 28, opacity: 0 }, '-=0.30')
      .from('.hero-tagline',  { y: 16, opacity: 0 }, '-=0.35')
      .from('.hero-cta',      { y: 12, opacity: 0, duration: 0.45 }, '-=0.25')
      .addLabel('settled')
      .to('.hero-backdrop',   { opacity: 0.32, duration: 1.6, ease: 'sine.inOut', repeat: -1, yoyo: true }, '+=0.1');
  })();
</script>
```

Five beats. Logo arrives with a `back.out` toy-pop (`scale: 0.8 → 1` + `y: 24 → 0`). Title overlaps the logo's tail by 0.30s. Tagline cuts in 0.35s before the title finishes. CTA lands tight against the tagline. After everything has `settled`, the backdrop starts a slow breathing pulse — `repeat: -1, yoyo: true` is the only loop in the whole sequence.

### Example 2 — User-triggered modal open with paused timeline

```html
<button id="open">Open dialog</button>
<div class="overlay" id="overlay"></div>
<div class="modal" id="modal">
  <h2>Confirm action</h2>
  <p>This cannot be undone.</p>
  <div class="modal-actions">
    <button class="btn-secondary">Cancel</button>
    <button class="btn-primary">Delete</button>
  </div>
</div>
<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); opacity: 0; pointer-events: none; z-index: 10; }
  .modal { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%) translateY(20px) scale(0.96); opacity: 0; background: var(--surface); padding: 28px 32px; border-radius: 12px; min-width: 360px; pointer-events: none; z-index: 11; }
</style>
<script>
  (function () {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } });
    tl.to('.overlay', { opacity: 1, pointerEvents: 'auto', duration: 0.20 })
      .to('.modal',   { opacity: 1, y: 0, scale: 1, pointerEvents: 'auto', duration: reduced ? 0 : 0.30 }, '<0.05');
    document.getElementById('open').addEventListener('click', () => tl.restart());
    document.getElementById('overlay').addEventListener('click', () => tl.reverse());
  })();
</script>
```

`paused: true` is the key — the timeline is built once when the page loads, then `tl.restart()` plays it forward on click and `tl.reverse()` runs it backwards on overlay dismiss. No re-creation per click. The reduced-motion guard collapses the modal duration to 0 (instant) instead of removing the effect entirely — users still get the modal, just without the slide.

### Example 3 — Stagger card entrance feeding into a timeline

```html
<section class="features">
  <article class="feature-card">One</article>
  <article class="feature-card">Two</article>
  <article class="feature-card">Three</article>
  <article class="feature-card">Four</article>
</section>
<style>
  .features { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 80px 6vw; }
  .feature-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
</style>
<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
    tl.from('.features', { opacity: 0, duration: 0.4 })
      .from('.feature-card', {
        y: 24, opacity: 0, duration: 0.5,
        stagger: { each: 0.07, from: 'start' },
      }, '-=0.15')
      .to('.feature-card', {
        boxShadow: '0 6px 24px rgba(0,0,0,0.06)',
        duration: 0.6, ease: 'sine.out',
      }, '-=0.20');
  })();
</script>
```

Three timeline children, but the middle one expands into N tweens via `stagger`. The third tween (`boxShadow`) starts 0.20s before the stagger finishes, so the cards arrive AND their shadows start settling at the same time. Without a timeline this is three `setTimeout` calls with magic numbers.

---

## Anti-patterns

- **`gsap.to(a, { delay: 0.0 }); gsap.to(b, { delay: 0.3 }); gsap.to(c, { delay: 0.6 });`** Stop. That's a hand-rolled timeline with no seek, reverse, kill, or label. Hoist to `gsap.timeline()` with position parameters.
- **`tl.to(...).to(...).delay(0.3)`** Stop. `delay:` inside a timeline child is ignored or overrides the position param confusingly. Use `'+=0.3'` as the third arg.
- **Creating a fresh timeline on every click.** Stop. Build once with `paused: true`, then `restart()` / `reverse()` / `play()` on events. Otherwise listeners and tween objects leak forever.
- **`repeat: -1` on a hero reveal.** Stop. Looped entrance animations read as broken. Use `repeat: -1, yoyo: true` only for ambient effects (pulses, breathing).
- **Forgetting `defaults:` and repeating `ease:` on every line.** Stop. `gsap.timeline({ defaults: { ease: 'power2.out', duration: 0.5 } })` and then individual lines override only when they need to.
- **Animating `width` / `height` / `top` / `left` inside the timeline.** Same rule as `/motion-library`: layout properties drop frames. Stick to `x`, `y`, `scale`, `rotation`, `opacity`.
- **Skipping the `prefers-reduced-motion` guard.** Same rule. One `if` block at the top.
- **Reaching for a timeline for two tweens.** Stop. Two `gsap.to()` calls with one `delay:` is fine. Timelines pay off at three steps or more.
