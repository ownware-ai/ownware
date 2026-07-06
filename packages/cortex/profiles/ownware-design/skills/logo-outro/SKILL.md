---
name: logo-outro
description: 'A single-frame end-of-video VFX pattern — brand logo fades in (300ms), URL slides up from below (200ms after, +500ms start), 800ms hold, all elements fade together (400ms). Total ~1.7s, freezes on final frame. Pure CSS @keyframes or one GSAP timeline. Use for video outros, brand stings, page-load reveals. Skip when the brief asks for continuous motion or interactive elements — this is a one-shot, plays once, freezes.'
trigger: /logo-outro
---

# Logo Outro — 1.7-second brand sign-off

## Overview

A logo outro is the last 1–2 seconds of a video, a page intro that resolves, or a brand sting that says "and that's us." The shape is fixed: lockup arrives, URL/handle slides up under it, both hold for a beat so the viewer can read them, both fade together on the way out OR freeze on the final frame for video capture.

This is a one-shot effect — it plays once, never loops. For sustained motion use `/motion-library`; for orchestrated multi-step heroes use `/motion-timeline`. The outro is a single ~1.7s sequence with three beats: arrive, hold, exit (or freeze).

---

## Critical Constraints — read these first, every time

1. **Total runtime: 1.5–2.0 seconds.** Longer than 2s and the viewer thinks the video is buffering; shorter than 1.5s and the URL can't be read. The standard split: 300ms logo-in, 200ms gap, 200ms URL-in, 800ms hold, 400ms fade out (= 1900ms). Or for video capture, drop the fade-out and freeze.
2. **Logo arrives first, URL arrives 500ms later.** The eye lands on the brand mark first, registers it, then the secondary text appears. Reversing this order makes the URL feel primary, which it isn't.
3. **`animation-fill-mode: both`** on every animated element. Without it, the element flashes to its from-state on page load and to its end-state instantly after the animation. `both` clamps the timeline so the keyframes hold at both ends.
4. **`animation-iteration-count: 1`.** This is a one-shot. No `infinite`. No `2`. Once.
5. **For video captures, drop the fade-out and let the final frame freeze.** The whole point of an outro is the end-card that the video editor pulls a still from. A fading frame at the end is useless for that. Either fade-out OR freeze — not both.
6. **Honor `prefers-reduced-motion`.** Static end-state — show logo + URL fully visible, no motion. The user still sees the brand.
7. **No external logo image.** Logo is inline SVG or pure-CSS geometry. Outros are often rendered in iframes / video frames where external image fetches block or fail.
8. **Center everything.** The outro is symmetric by tradition — a hero centered lockup with the URL underneath. Asymmetric outros exist but require explicit brief signoff.

---

## Concrete examples — two full patterns

### Example 1 — Pure-CSS outro that fades out at the end

A 1900ms total sequence. Logo (a simple diamond mark + wordmark) arrives, URL appears 500ms in, both hold for 800ms, both fade together.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Logo outro</title>
  <style>
    :root { --bg: #08090c; --fg: #f3f5f7; --accent: #7c5cff; --muted: rgba(243,245,247,0.6); }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg);
           display: grid; place-items: center; font-family: "Inter Tight", system-ui, sans-serif; }
    .outro { text-align: center; }

    /* Lockup — mark + wordmark, animated as one element. */
    .outro-lockup {
      display: flex; align-items: center; justify-content: center; gap: 16px;
      opacity: 0; transform: translateY(8px);
      animation: lockup-in 300ms cubic-bezier(0.22, 0.61, 0.36, 1) 0ms both,
                 fade-out 400ms ease-in 1500ms both;
    }
    .outro-mark { width: 48px; height: 48px; }
    .outro-mark rect { fill: var(--accent); }
    .outro-wordmark { font-size: 52px; font-weight: 700; letter-spacing: -0.02em; }

    /* URL — appears 500ms after start, fades out with the lockup. */
    .outro-url {
      margin-top: 18px;
      font-size: 17px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      opacity: 0; transform: translateY(12px);
      animation: url-in 200ms cubic-bezier(0.22, 0.61, 0.36, 1) 500ms both,
                 fade-out 400ms ease-in 1500ms both;
    }

    @keyframes lockup-in { to { opacity: 1; transform: translateY(0); } }
    @keyframes url-in    { to { opacity: 1; transform: translateY(0); } }
    @keyframes fade-out  { to { opacity: 0; } }

    @media (prefers-reduced-motion: reduce) {
      .outro-lockup, .outro-url { opacity: 1; transform: none; animation: none; }
    }
  </style>
</head>
<body>
  <div class="outro" data-cx-id="outro">
    <div class="outro-lockup">
      <svg class="outro-mark" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" transform="rotate(45 12 12)" />
      </svg>
      <span class="outro-wordmark">Ownware</span>
    </div>
    <div class="outro-url">ownware.so</div>
  </div>
</body>
</html>
```

Two animations per element: an "in" at the right delay and a shared "fade-out" at 1500ms. Total: 1900ms (1500 + 400). The `cubic-bezier(0.22, 0.61, 0.36, 1)` is a "settle" curve — faster at the start, gentler at the land, the right feel for a brand sign-off. The reduced-motion fallback shows the end-state statically.

### Example 2 — GSAP timeline outro that freezes on the final frame (video-capture mode)

For video-capture, no fade-out — the last frame is the deliverable.

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<div class="outro">
  <div class="outro-lockup">
    <svg class="outro-mark" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" transform="rotate(45 12 12)" fill="#7c5cff"/></svg>
    <span class="outro-wordmark">Ownware</span>
  </div>
  <div class="outro-url">ownware.so</div>
</div>
<style>
  body { margin: 0; min-height: 100vh; background: #08090c; color: #f3f5f7;
         display: grid; place-items: center; font-family: "Inter Tight", system-ui, sans-serif; }
  .outro { text-align: center; }
  .outro-lockup { display: flex; align-items: center; justify-content: center; gap: 16px; }
  .outro-mark { width: 48px; height: 48px; }
  .outro-wordmark { font-size: 52px; font-weight: 700; letter-spacing: -0.02em; }
  .outro-url { margin-top: 18px; font-size: 17px; letter-spacing: 0.08em; text-transform: uppercase;
               color: rgba(243,245,247,0.6); }
</style>
<script>
  (function () {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    if (reduced) {
      // Static end-state; no animation.
      gsap.set(['.outro-lockup', '.outro-url'], { opacity: 1, y: 0 });
      return;
    }
    tl.from('.outro-lockup', { opacity: 0, y: 8,  duration: 0.30 })
      .from('.outro-url',    { opacity: 0, y: 12, duration: 0.20 }, '+=0.20')
      .addLabel('held')
      .to({}, { duration: 0.80 });   // empty tween = 800ms hold; sequence ends frozen.
  })();
</script>
```

300ms lockup in, 200ms gap (`'+=0.20'`), 200ms URL in, 800ms hold, freeze. Total: 1500ms then a held frame indefinitely. The empty tween `.to({}, { duration: 0.80 })` is the standard "pause the timeline without animating anything" idiom — gives the video editor an obvious end-card to capture.

---

## Anti-patterns

- **Total runtime over 2 seconds.** Stop. Viewers think the player froze. Keep total ≤ 2.0s.
- **Looping the outro.** Stop. `animation-iteration-count: 1` only. Looped outros read as broken playback.
- **External `<img src="https://cdn…/logo.png">`.** Stop. CDN fetches block or fail in iframe-captured renders. Inline SVG or CSS geometry only.
- **URL arrives before logo.** Stop. The order is brand mark → wordmark → URL. Reversing it makes the URL feel primary, which it isn't.
- **Fade-out AND freeze.** Stop. Pick one: fade-out for page contexts where the next thing follows, freeze for video-capture where the still frame IS the deliverable.
- **Skipping `animation-fill-mode: both`.** Stop. Without it the element flashes to its from-state on load (logo invisible for a frame, then animates in) and snaps to end-state instantly. `both` is mandatory.
- **Forgetting `prefers-reduced-motion`.** Stop. Static end-state shown immediately; the user still sees the brand.
- **Asymmetric outros without brief signoff.** Stop. Tradition for sign-off frames is centered lockup. Deviating is fine but needs an explicit reason in the brief.
