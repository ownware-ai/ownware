---
name: microinteractions
description: 'Small UI feedback patterns that signal alive — button-press, toggle-flip, like-tap, copy-confirm, hover-card preview, checkbox draw, accordion expand, toast slide. CSS/GSAP code per pattern with timings, easings, and reduced-motion fallbacks. Use when polishing an interactive component or when the brief asks for "feels responsive". Pairs with /motion-library (GSAP fundamentals) and /motion-system (token-level motion).'
trigger: /microinteractions
---

# Microinteractions — every action earns feedback

## Overview

A microinteraction is the 100–400ms reply a UI gives when the user does something. Tap a button, the surface depresses. Toggle a switch, the thumb slides. Tap a heart, it pops and emits two particles. Copy a link, the icon flips to a checkmark for 1.2 seconds. The cumulative effect of these tiny moves is the difference between a UI that feels alive and one that feels dead.

The discipline: every input deserves an output. Not necessarily a big one — the cheapest microinteraction is a 80ms scale on press. But silent inputs are a tell that the agent wired a button without designing it.

Use this skill when polishing an interactive surface — settings page, like buttons, share buttons, toggles, copy controls, checkboxes, accordions. Don't use it for entrance animations across a whole page (that's `/motion-library`) or for scroll-driven motion (`/scroll-motion`).

---

## Critical Constraints — read these first, every time

1. **Every interactive element earns at least one piece of feedback.** Hover (desktop), press (mobile), success, error. Silent inputs are a bug.
2. **Timings stay short.** UI microinteractions live in 80–400ms. Anything > 400ms reads as cinematic, not responsive. Reserve longer durations for scene transitions.
3. **Ease-out for entrances and presses. Ease-in for exits.** Press-DOWN is `ease-out` (settles into the depressed state). Press-UP is `ease-out` (settles back to rest). Toasts entering: `ease-out`. Toasts leaving: `ease-in`. Default reads natural; cubic-bezier(0.32, 0.72, 0, 1) (a fast `power3.out`) is the iOS sheet feel.
4. **Reduced-motion has a fallback per pattern.** Wrap CSS animations in `@media (prefers-reduced-motion: no-preference) { ... }`. The reduced state still confirms the action — color change, icon swap — but without scale, slide, or rotation.
5. **One microinteraction per element.** Don't stack a scale + a glow + a particle burst on the same button. Pick the strongest move; the rest is noise.
6. **Feedback must beat 100ms.** The interaction starts within 100ms of the user's input. If your animation kicks off at 200ms because of a re-render, the user already feels lag.

---

## Framework — the 8-pattern microinteraction library

### Pattern 1 — Button press (lift + depress)

The simplest pattern. Press the button, it depresses 1–2px and scales 0.98. Release, it returns. 80–120ms each way.

```css
.btn { transition: transform 100ms ease-out, box-shadow 100ms ease-out; }
.btn:active { transform: translateY(1px) scale(0.98); box-shadow: none; }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } .btn:active { transform: none; } }
```

Reduced-motion fallback: keep the `:active` color shift (built into normal button styles) — the user still sees acknowledgment.

### Pattern 2 — Toggle slide (200ms ease-out)

Switch thumb slides from off → on position; track color shifts; both in 200ms `ease-out`. The pattern Apple uses for every iOS Settings toggle.

```css
.toggle { width: 44px; height: 26px; background: var(--border); border-radius: 13px; position: relative; cursor: pointer; transition: background 200ms ease-out; }
.toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; background: #fff; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,0.2); transition: transform 200ms cubic-bezier(0.32, 0.72, 0, 1); }
.toggle[aria-checked="true"] { background: var(--accent); }
.toggle[aria-checked="true"]::after { transform: translateX(18px); }
@media (prefers-reduced-motion: reduce) { .toggle, .toggle::after { transition: background 100ms linear; } }
```

Reduced-motion fallback: drop the slide; keep the background-color shift instantly.

### Pattern 3 — Like tap (heart pop + particles)

Tap heart, scales 0→1.3→1.0 over 400ms with 4–6 small particles bursting outward. The dopamine pattern (Twitter/X, Instagram).

```html
<button class="like" aria-pressed="false" data-cx-id="like-btn">
  <svg class="heart" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.5-9.5-9C0.5 7.5 4 3 8 5c1.5.75 3 2 4 3 1-1 2.5-2.25 4-3 4-2 7.5 2.5 5.5 7-2.5 4.5-9.5 9-9.5 9z"/></svg>
</button>
<style>
  .like { background: none; border: 0; cursor: pointer; padding: 8px; color: var(--muted); }
  .like .heart { width: 24px; height: 24px; transition: color 200ms ease-out; }
  .like[aria-pressed="true"] .heart { color: var(--bad); animation: heart-pop 400ms cubic-bezier(0.32, 0.72, 0, 1); }
  @keyframes heart-pop { 0% { transform: scale(1); } 30% { transform: scale(1.3); } 60% { transform: scale(0.92); } 100% { transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) { .like[aria-pressed="true"] .heart { animation: none; } }
</style>
<script>
  document.querySelector('.like').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const pressed = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!pressed));
    if (!pressed && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) burst(btn);
  });
  function burst(host) {
    for (let i = 0; i < 5; i++) {
      const dot = document.createElement('span');
      const angle = (i / 5) * Math.PI * 2;
      Object.assign(dot.style, { position: 'absolute', width: '5px', height: '5px', background: 'var(--bad)', borderRadius: '50%', pointerEvents: 'none', transition: 'transform 380ms cubic-bezier(0.2, 0.7, 0.3, 1), opacity 380ms ease-out' });
      host.style.position = 'relative';
      host.appendChild(dot);
      requestAnimationFrame(() => {
        dot.style.transform = `translate(${Math.cos(angle) * 22}px, ${Math.sin(angle) * 22}px)`;
        dot.style.opacity = '0';
      });
      setTimeout(() => dot.remove(), 420);
    }
  }
</script>
```

Reduced-motion fallback: color change only (gray → red). No scale, no particles.

### Pattern 4 — Copy confirm (icon swap for 1.2s)

User clicks copy button. The clipboard icon flips to a checkmark for 1.2 seconds, then reverts. The copy IS the success — no toast needed.

```html
<button class="copy" data-cx-id="copy-btn">
  <svg class="ic-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
  <svg class="ic-check" viewBox="0 0 24 24" fill="none" stroke="var(--good)" stroke-width="2.25" style="display:none"><path d="m5 12 5 5L20 7"/></svg>
</button>
<script>
  document.querySelector('.copy').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText('https://example.com');
    const c = e.currentTarget;
    c.querySelector('.ic-copy').style.display = 'none';
    c.querySelector('.ic-check').style.display = '';
    setTimeout(() => {
      c.querySelector('.ic-copy').style.display = '';
      c.querySelector('.ic-check').style.display = 'none';
    }, 1200);
  });
</script>
```

1.2s is long enough to read as "yes that worked" and short enough that the next click feels fresh. Don't extend past 1.5s.

### Pattern 5 — Hover-card preview (150ms fade-in, 80ms fade-out)

Hover over a link, a card preview fades in after 400ms delay; mouse-out, fades immediately. Stripe's docs do this for API references.

```css
.has-preview { position: relative; }
.preview { position: absolute; top: 100%; left: 0; min-width: 280px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.10); opacity: 0; transform: translateY(-4px); pointer-events: none; transition: opacity 150ms ease-out, transform 150ms ease-out; transition-delay: 400ms; }
.has-preview:hover .preview { opacity: 1; transform: translateY(0); pointer-events: auto; transition-delay: 0ms; }
```

400ms hover-intent delay prevents accidental triggers when the mouse passes through.

### Pattern 6 — Checkbox check-mark draw (200ms stroke-dasharray)

The check-mark draws on, left to right, in 200ms. Used by Linear, GitHub.

```css
.check-svg path { stroke-dasharray: 20; stroke-dashoffset: 20; transition: stroke-dashoffset 200ms ease-out; }
input[type="checkbox"]:checked + .check-svg path { stroke-dashoffset: 0; }
```

The element exists at all times (no opacity pop); only the stroke draws. Reduced-motion fallback: skip the dasharray; show the check instantly on `:checked`.

### Pattern 7 — Accordion expand (height + fade, 250ms)

The accordion grows to its content height while content fades in. Use `grid-template-rows: 0fr → 1fr` trick to avoid measuring height in JS.

```css
.accordion-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 250ms ease-out; }
.accordion-body > div { overflow: hidden; opacity: 0; transition: opacity 200ms ease-out 50ms; }
.accordion[aria-expanded="true"] .accordion-body { grid-template-rows: 1fr; }
.accordion[aria-expanded="true"] .accordion-body > div { opacity: 1; }
```

The `1fr` grid trick is the modern way — no `max-height: 9999px` hack.

### Pattern 8 — Toast slide-in (300ms ease-out, auto-dismiss 4s)

Toast enters from below-right, sits for 4 seconds, exits to below. 300ms in, 200ms out.

```css
.toast { position: fixed; bottom: 16px; right: 16px; transform: translateY(120%); opacity: 0; transition: transform 300ms cubic-bezier(0.32, 0.72, 0, 1), opacity 300ms ease-out; }
.toast.show { transform: translateY(0); opacity: 1; }
.toast.exit { transform: translateY(120%); opacity: 0; transition-duration: 200ms; transition-timing-function: ease-in; }
```

JS adds `.show` on mount, swaps to `.exit` after 4s, removes after another 200ms. For error toasts, double the dwell time to 8s — the user needs to read.

---

## Concrete example — settings page with all four patterns wired

```html
<section class="settings" data-cx-id="settings-panel">
  <div class="row">
    <span>Email notifications</span>
    <button class="toggle" aria-checked="true" role="switch"></button>
  </div>
  <div class="row">
    <span>Use system theme</span>
    <label><input type="checkbox" /><svg class="check-svg" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7" fill="none" stroke="var(--accent)" stroke-width="2.25"/></svg></label>
  </div>
  <div class="row">
    <span>API key</span>
    <button class="copy">
      <svg class="ic-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
      <svg class="ic-check" viewBox="0 0 24 24" fill="none" stroke="var(--good)" stroke-width="2.25" style="display:none"><path d="m5 12 5 5L20 7"/></svg>
    </button>
  </div>
  <button class="btn-primary">Save changes</button>
</section>
```

Wired with the patterns above: toggle slides, checkbox draws, copy flips to check, save-button depresses on press. Four microinteractions, none louder than the work they do.

---

## Anti-patterns

- **Silent buttons.** A primary button with no `:active` state. Tells the user nothing happened.
- **Animations >400ms on UI elements.** Slow microinteractions read as lag. 80–400ms is the band.
- **Stacking three effects on one element.** Scale + glow + particles on a single tap is noise. Pick one.
- **Spring bounces on UI.** `cubic-bezier` with overshoot (e.g. `back.out(1.7)`) reads as cartoon for buttons and toggles. Save for explicit playful moments (a Like burst, a star-rating tap).
- **Reduced-motion never tested.** The `@media (prefers-reduced-motion: reduce)` block is theatre if you never enable the OS toggle and load the page. Test it.
- **Hover-only patterns.** Mobile users have no hover. Every hover interaction needs a tap equivalent — long-press for preview, tap for action.
- **Animating on every state change.** A form field shouldn't animate-validate on every keystroke; only on blur or submit. The user feels nagged.
- **Pattern mismatch.** Using `ease-in` for an entrance (the animation starts slow, lurches in) — reads as broken. Entrances are `ease-out`. Exits are `ease-in`.
- **Microinteraction that delays the actual work.** A copy button that animates for 400ms before writing to clipboard — the user starts moving the cursor before the copy completes. Run the work immediately; the animation is parallel.
