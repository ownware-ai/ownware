---
name: motion-library
description: 'Add GSAP-based UI motion to a single-file HTML artifact via CDN — hover lifts, hero headline reveals, stagger card entries, micro-feedback on click. Use when the brief asks for "feels alive", "more polish", or "motion language", and a one-line CSS transition isn''t enough. Skip for scroll-driven motion (use /scroll-motion), for full-scene video (use /video-renderer), or when prefers-reduced-motion=reduce should kill the effect — in that case write CSS first and add motion second.'
trigger: /motion-library
---

# Motion Library — GSAP, the artifact way

## Overview

GSAP (GreenSock Animation Platform) is the boring, reliable choice for entrance animations, hover states, and stagger reveals inside a single-file HTML artifact. CDN-loaded, no bundler, no npm. This skill covers the base library — `gsap.to/from/fromTo`, easings, stagger, and a vanilla-DOM substitute for the paid `SplitText` plugin. For scroll-triggered motion (pin, scrub, parallax), use the `/scroll-motion` skill — it loads the same `gsap.min.js` plus the free ScrollTrigger plugin.

A GSAP block earns its place when the motion is the brand — landing pages where the hero reveal sets the tone, marketing sites where stagger cards differentiate from a static grid. Skip GSAP when one CSS `transition: transform 0.2s ease-out` does the same job; loading 60kB for a button hover is overkill.

---

## Critical Constraints — read these first, every time

1. **Pin the CDN.** Load from `https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js`. Never an unpinned `gsap/latest`. A future GSAP release silently changes easing curves on you otherwise.
2. **`gsap.from()` for entrance, `gsap.to()` for exit, `gsap.fromTo()` when you need both ends explicit.** `from` reads as "where the element is coming from" — most natural for fade-in / slide-in moves.
3. **Always set `ease`.** Default is `power1.out`, which is fine but bland. Pick deliberately from the scale in the Framework below.
4. **Honor `prefers-reduced-motion`.** Wrap the entire init block in `if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) { ... }`. Vestibular-sensitive users get the static page, no spinning, no fades.
5. **No paid plugins.** SplitText, MorphSVG, DrawSVG, MotionPathPlugin require a GSAP Club membership and license-key registration the artifact can't ship. Use the vanilla-DOM substitutes below.
6. **One animation per element.** Stacking two `gsap.to()` calls on the same property of the same element fights itself. Use a single tween or a `gsap.timeline()` to choreograph.
7. **Tween transforms and opacity only.** GSAP can animate `width`, `height`, `top`, `left` — don't. Those trigger layout. Stick to `x`, `y`, `scale`, `rotation`, `opacity`. Browser only paints; 60fps stays cheap.

---

## Framework — the easing scale (memorize)

Pick by feel, not by name length. These are the seven you'll use 95% of the time.

| Ease | When to use | Vibe |
|------|-------------|------|
| `power1.out` | Default UI fade-ins, button hovers | Soft, polite |
| `power2.out` | Hero headline reveal, primary card entry | Confident, the workhorse |
| `power3.out` | Big bold moves — modal open, sheet slide-up | Decisive, snappy |
| `power4.out` | Reserved — feels almost too sharp | Rare, near-instant settle |
| `expo.out` | Long-distance moves that need to feel fast at start, gentle at land | Cinematic |
| `circ.out` | Curved moves, image scale-ups, "natural" arcs | Organic |
| `sine.inOut` | Loops, pulses, breathing icons | Hypnotic |
| `back.out(1.4)` | Playful chip-pop, badge entry, "the thing arrived" moment | Toy-like — use sparingly |

Never use `ease: 'bounce'` for UI motion. Reads as cartoon. Never use any `*.in` ease for an entrance — entrances accelerate from rest, which is `.out`. `.in` is for exits leaving the screen.

---

## Concrete examples — three full patterns

### Example 1 — Hero headline reveal with stagger subtitle

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<section data-cx-id="hero" class="hero">
  <h1 class="hero-h1">Ship faster with Acme</h1>
  <p class="hero-sub">The deploy platform engineers actually like.</p>
  <div class="hero-actions">
    <a class="btn-primary" href="#cta">Start free</a>
    <a class="btn-secondary" href="#demo">Watch a demo</a>
  </div>
</section>
<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
    tl.from('.hero-h1', { y: 24, opacity: 0, duration: 0.6 })
      .from('.hero-sub', { y: 16, opacity: 0, duration: 0.5 }, '-=0.35')
      .from('.hero-actions > *', { y: 12, opacity: 0, duration: 0.4, stagger: 0.08 }, '-=0.25');
  })();
</script>
```

The negative-offset position param (`'-=0.35'`) overlaps the next tween with the previous by 0.35s — keeps the cascade tight. `stagger: 0.08` is the right interval for 2–4 sibling buttons; bump to `0.12` for a 6-card row.

### Example 2 — Vanilla-DOM word-by-word reveal (SplitText substitute)

SplitText is a paid plugin. The vanilla substitute is one helper function — split the headline into `<span>`s, animate the spans.

```html
<h1 class="big-headline" data-split>Design that ships itself.</h1>
<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const h = document.querySelector('[data-split]');
    const words = h.textContent.trim().split(/\s+/);
    h.innerHTML = words
      .map(w => `<span class="word" style="display:inline-block;">${w}</span>`)
      .join(' ');
    gsap.from('.word', {
      y: '100%',
      opacity: 0,
      duration: 0.7,
      ease: 'expo.out',
      stagger: 0.06,
    });
  })();
</script>
```

`display: inline-block` is mandatory — without it, the `y` transform does nothing on inline elements. For per-character reveal (use sparingly — characters feel toy-like for long headlines), split on `''` instead of whitespace and bump duration up to `0.5` per char with a tighter `stagger: 0.025`.

### Example 3 — Hover lift + press feedback on a card grid

```html
<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; cursor: pointer; }
</style>
<div class="card-grid">
  <article class="card">Card one</article>
  <article class="card">Card two</article>
  <article class="card">Card three</article>
</div>
<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('.card').forEach(card => {
      const hoverIn  = () => gsap.to(card, { y: -4, scale: 1.01, duration: 0.25, ease: 'power2.out' });
      const hoverOut = () => gsap.to(card, { y: 0,  scale: 1,    duration: 0.3,  ease: 'power2.out' });
      const pressIn  = () => gsap.to(card, { scale: 0.99, duration: 0.1, ease: 'power1.out' });
      const pressOut = () => gsap.to(card, { scale: 1.01, duration: 0.2, ease: 'power2.out' });
      card.addEventListener('mouseenter', hoverIn);
      card.addEventListener('mouseleave', hoverOut);
      card.addEventListener('pointerdown', pressIn);
      card.addEventListener('pointerup', pressOut);
    });
  })();
</script>
```

`y: -4` is the right lift on a card. `-6` and `-8` work for marketing heroes; anything more feels gimmicky. `scale: 1.01` is the "barely there" hint — never `scale: 1.05` on a card grid; that's loud enough to read as broken.

---

## Anti-patterns

- **Reaching for SplitText, MorphSVG, DrawSVG.** Stop. They're paid. The vanilla `<span>` split in Example 2 covers 90% of what SplitText does. The other 10% — character-level scramble, line masking — re-evaluate whether the motion is earning its keep.
- **Animating `width`, `height`, `top`, `left`, `margin`.** Stop. Layout-trigger properties drop frames. Use `x`, `y`, `scale`, `rotation` (which compile to `transform: matrix3d`) and the GPU stays happy.
- **`ease: 'bounce'` or `ease: 'elastic'` on UI motion.** Stop. Reads as cartoon. Reserve for explicit playful brands (kids' product, retro pixel art).
- **Forgetting `prefers-reduced-motion`.** Stop. One `if` block at the top of the script guard. Without it the artifact fails an accessibility review on first glance.
- **Stacking two `gsap.to()` calls on the same property.** Stop. They fight. Use `gsap.timeline()` and sequence them.
- **`gsap.set(el, { ... })` for the entrance state, then animating to.** Stop unless the visual flash before the script runs would be ugly. `gsap.from()` is the same thing in one call.
- **CDN without a pinned version.** Stop. `gsap@3.12.5` is the right spelling. `gsap@latest` is a footgun.
- **Using GSAP for a one-line transition.** Stop. `transition: transform 0.2s ease-out` in CSS is 0kB. GSAP is 60kB. Use GSAP when the choreography earns it (timelines, stagger, splits) — not for a single hover.
