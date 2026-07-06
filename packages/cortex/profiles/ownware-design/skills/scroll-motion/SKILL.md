---
name: scroll-motion
description: 'Scroll-driven motion in a single-file HTML artifact via GSAP ScrollTrigger — pinned sections, scrub-bound timelines, parallax layers, batch reveals, sticky-progress sidebars. Use when the page tells a story top-to-bottom and the scrollbar is the user''s playhead. Skip for entrance animations, hover state, headline reveals — those belong in /motion-library. Skip when one CSS position-sticky is enough.'
trigger: /scroll-motion
---

# Scroll Motion — ScrollTrigger, the artifact way

## Overview

ScrollTrigger is the free GSAP plugin that turns the viewport into an animation playhead. Pin a hero so the user scrolls through it without it leaving the screen. Bind a timeline to scroll progress so a chart draws itself as the user reads. Parallax a product image behind a section. Reveal a card grid one column at a time as it enters view.

For non-scroll motion — hero reveals, hover lifts, stagger entry on page load — use `/motion-library` instead. This skill assumes you already know GSAP basics; the constraints and easing scale from `/motion-library` apply here too.

A scroll story earns its place when the page is editorial, when there's a "before / during / after" arc to walk the user through, when product features unfold sequentially. Skip it for dashboards, app surfaces, and dense reference pages — scroll motion gets in the way of scanning.

---

## Critical Constraints — read these first, every time

1. **Two CDN scripts, both pinned.** `https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js` AND `https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js`. Then `gsap.registerPlugin(ScrollTrigger)`. Skip the register and triggers silently no-op.
2. **`prefers-reduced-motion: reduce` kills the whole skill.** All scroll-bound animation is vestibularly hostile. Guard the init block; if reduce is set, render the page static and exit.
3. **`scrub: true` for scroll-bound playback. `scrub: 1` for smoothed (recommended).** `true` = 1:1 with scrollbar, twitchy. `scrub: 1` = 1s catch-up, feels expensive in a good way.
4. **Pin only what's worth pinning.** A pinned hero is one section; pinning three sections in a row produces a janky page. Budget: at most one pin per page, two if the second is short.
5. **Cleanup `ScrollTrigger.kill()` on dynamic remounts.** If the artifact uses React via CDN (rare in this profile) or rebuilds DOM on user action, every `ScrollTrigger.create()` leaves a listener. Call `ScrollTrigger.getAll().forEach(t => t.kill())` before re-creating. Static artifacts don't need this.
6. **`ScrollTrigger.refresh()` after DOM that changes height.** If you append rows, load images that resize the page, or toggle a collapse, the trigger boundaries are stale. Call `ScrollTrigger.refresh()` once after the change settles.
7. **Markers ON during dev, OFF on ship.** `markers: true` paints red/green debug bars at start/end. Useful while tuning, ugly on release — strip before handoff.
8. **Don't pin and scrub the same trigger inside another pinned trigger.** Nested pins fight. If you find yourself wanting that, split into separate sections.

---

## Concrete examples — three full patterns

### Example 1 — Pinned hero with scrub word-by-word reveal

The viewport stops on the hero. As the user scrolls, the headline unscrambles word-by-word. After the headline lands, the pin releases and the page continues.

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>

<section class="hero" data-cx-id="hero">
  <h1 class="hero-h1" data-split>One platform. Every product. Zero compromise.</h1>
</section>
<section class="next" data-cx-id="next"><p>Content continues here…</p></section>

<style>
  .hero { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .hero-h1 { font-size: clamp(36px, 6vw, 88px); letter-spacing: -0.02em; text-wrap: balance; margin: 0; }
  .word { display: inline-block; will-change: transform, opacity; }
</style>

<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.registerPlugin(ScrollTrigger);

    const h = document.querySelector('[data-split]');
    h.innerHTML = h.textContent.trim().split(/\s+/)
      .map(w => `<span class="word">${w}</span>`).join(' ');

    gsap.from('.word', {
      opacity: 0.15,
      y: 20,
      ease: 'none',           // scrub owns the timing — no curve on the tween itself
      stagger: 0.1,
      scrollTrigger: {
        trigger: '.hero',
        start: 'top top',     // when the hero top hits the viewport top
        end: '+=600',         // 600px of scroll distance after that
        scrub: 1,             // 1s catch-up smoothing
        pin: true,            // keep the hero on screen for those 600px
        anticipatePin: 1,     // smooths the moment of pinning
      },
    });
  })();
</script>
```

`start: 'top top'` and `end: '+=600'` are the two values to tune. Shorter `end` = faster reveal, more abrupt feel. `+=400` is brisk; `+=900` is luxurious. `ease: 'none'` is essential when `scrub` is on — let the scrollbar be the easing.

### Example 2 — Parallax product image behind a scrolling section

Image moves slower than the text in front of it as the user scrolls. Classic editorial move.

```html
<section class="product" data-cx-id="product">
  <img class="product-bg" src="./hero.png" alt="" />
  <div class="product-copy">
    <h2>The dashboard that writes itself.</h2>
    <p>AI picks the metrics. You pick the time range.</p>
  </div>
</section>

<style>
  .product { position: relative; min-height: 120vh; overflow: hidden; }
  .product-bg { position: absolute; inset: -10% 0; width: 100%; height: 120%; object-fit: cover; will-change: transform; }
  .product-copy { position: relative; z-index: 2; padding: 18vh 6vw; color: #fff; }
</style>

<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.registerPlugin(ScrollTrigger);

    gsap.to('.product-bg', {
      yPercent: -20,            // image rises 20% of its height as we scroll past
      ease: 'none',
      scrollTrigger: {
        trigger: '.product',
        start: 'top bottom',    // begin when the section top enters from below
        end: 'bottom top',      // end when the section bottom exits at top
        scrub: true,
      },
    });
  })();
</script>
```

The `inset: -10% 0; height: 120%` on the image is mandatory — without the extra height, the parallax reveals empty page at the top of the section as the image slides up. `yPercent: -20` is the right magnitude for subtle; bump to `-35` for editorial-heavy pages.

### Example 3 — Batch reveal of a card grid as it enters view

Cards fade-and-slide in column by column. Uses `ScrollTrigger.batch` so the cards trigger as a group, not one per element.

```html
<section class="features" data-cx-id="features">
  <article class="card">Card one</article>
  <article class="card">Card two</article>
  <article class="card">Card three</article>
  <article class="card">Card four</article>
  <article class="card">Card five</article>
  <article class="card">Card six</article>
</section>

<style>
  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 80px 6vw; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; opacity: 0; }
</style>

<script>
  (function () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.querySelectorAll('.card').forEach(c => c.style.opacity = 1);
      return;
    }
    gsap.registerPlugin(ScrollTrigger);

    ScrollTrigger.batch('.card', {
      start: 'top 85%',                                // when card top reaches 85% of viewport
      onEnter: batch => gsap.to(batch, {
        opacity: 1, y: 0, duration: 0.6,
        ease: 'power2.out', stagger: 0.08, overwrite: true,
      }),
      once: true,                                      // fire once per card, don't reverse
    });
    gsap.set('.card', { y: 16 });                       // set the from-state once
  })();
</script>
```

`once: true` is the right default for reveals. Without it, cards fade out and back in as the user scrolls past, which looks broken. The `if (reduced)` branch sets `opacity: 1` so reduced-motion users still see the cards — never leave them invisible.

---

## Anti-patterns

- **Forgetting `gsap.registerPlugin(ScrollTrigger)`.** Stop. Without it `scrollTrigger:` silently no-ops. Add it once at the top.
- **`scrub: true` without `ease: 'none'` on the tween.** Stop. Two easing curves fight; the motion judders. When scrub is on, the scrollbar IS the easing.
- **Pinning every section.** Stop. Two pins per page max, and only when the content earns the pause. Otherwise the page feels stuck.
- **Animating `width`, `height`, `top`, `left` in a scrub.** Stop. Layout-trigger properties on every scroll tick = jank. Use `yPercent`, `x`, `scale`, `rotation`.
- **Long `end: '+=2000'` with three sections in one pin.** Stop. The user gets stuck for 2000px of scroll. Split into separate triggers, each with its own pin.
- **Leaving `markers: true` on a shipped artifact.** Stop. Red/green debug bars on the right edge of the viewport are a tell that the artifact didn't get a final pass.
- **Skipping `ScrollTrigger.refresh()` after content height changes.** Stop. Trigger boundaries cache on init; if the page grows (image loads, accordion expands), refresh once.
- **Driving DOM count inside a scrub callback.** Stop. The callback fires every scroll tick — 60+ times per second. Mutate transforms only; never append/remove nodes inside the tween.
- **Using ScrollTrigger when `position: sticky` would do.** Stop. A sticky sidebar that holds while a column scrolls past it is 3 lines of CSS, zero JS. Reach for ScrollTrigger only when the *animation* depends on scroll, not just the position.
