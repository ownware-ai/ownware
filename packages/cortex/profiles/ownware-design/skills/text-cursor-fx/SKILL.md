---
name: text-cursor-fx
description: 'Animated text-cursor / blinking-caret effects for hero text reveals. Three variants: classic terminal underscore-blink (1Hz), iOS-style line cursor (530ms blink), retro CRT chunky block. Pure CSS @keyframes — no JS unless typing-reveal is requested. Use to add a thin layer of motion personality to a hero h1, an opening sentence, a chat-style input mock. Skip when the whole hero is already heavily animated — caret blink competes with other motion.'
trigger: /text-cursor-fx
---

# Text Cursor FX — three caret variants

## Overview

A blinking caret is small motion that carries a lot of personality: terminal, OS shell, AI chat input, retro CRT. Picking the right caret variant signals the right voice without a single illustration. This skill defines three caret variants — pick one per hero, do not mix them on the same page.

The CSS is short. The discipline is in picking the right variant for the brief and getting the blink timing honest (a 1Hz square-wave blink reads differently than a 530ms iOS-style fade).

---

## Critical Constraints

1. **Pick ONE variant per page.** Mixing two carets on one page reads as inconsistency, not variety.
2. **`prefers-reduced-motion`.** When the user has reduced motion enabled, render a static caret (no animation). The caret stays visible; it just doesn''t blink.
3. **Caret color matches the text, never the accent.** A blinking accent caret is a chip flashing on the page; it overwhelms the headline. The caret is the same color as the text it follows.
4. **`inline-block` and align with the text baseline.** A caret floating above the baseline or sitting below it looks broken. Inline-block + vertical-align: baseline (or the variant-specific override below).
5. **Width sizes from the font, not from px hardcodes.** Use `em` so the caret scales with the headline size. A 9px caret next to 96px headline looks like a typo.
6. **`aria-hidden="true"` on the caret element.** Screen readers shouldn''t announce a blinking pipe. The headline''s actual text is what matters.

---

## The three variants

### Variant 1 — Classic terminal underscore (1Hz square-wave blink)

Old-school terminal: an underscore character that blinks on/off at 1Hz. Hard cut, no fade. Reads as "this is a developer surface."

```css
.caret-term {
  display: inline-block;
  width: 0.55em;
  height: 0.08em;
  background: currentColor;
  vertical-align: -0.05em;
  margin-left: 0.05em;
  animation: blink-term 1s steps(2, start) infinite;
}
@keyframes blink-term {
  to { visibility: hidden; }
}
@media (prefers-reduced-motion: reduce) {
  .caret-term { animation: none; }
}
```

`steps(2, start)` gives the hard square-wave on/off, no easing. 1Hz period (50% duty cycle).

### Variant 2 — iOS-style thin line cursor (530ms blink)

iOS input caret. A 2px-wide vertical line that fades in/out every 530ms (Apple''s system blink rate, measured from the iOS keyboard). Reads as "this is an OS-native surface" or "this is a modern chat input."

```css
.caret-ios {
  display: inline-block;
  width: 0.05em;
  min-width: 2px;
  height: 1em;
  background: currentColor;
  vertical-align: -0.12em;
  margin-left: 0.04em;
  animation: blink-ios 1.06s ease-in-out infinite;
}
@keyframes blink-ios {
  0%, 47% { opacity: 1; }
  53%, 100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .caret-ios { animation: none; opacity: 1; }
}
```

530ms visible, 530ms hidden, with a tight 6%-period crossfade at each transition — that''s the iOS feel.

### Variant 3 — Retro CRT chunky block (slow pulse, slight glow)

Retro arcade / 80s terminal feel. A solid block character (roughly em-wide × half-em tall) that pulses with a faint glow at 1.4Hz. Reads as "retro-aesthetic", "pixel-deck", "game UI mock."

```css
.caret-crt {
  display: inline-block;
  width: 0.55em;
  height: 0.7em;
  background: currentColor;
  vertical-align: -0.08em;
  margin-left: 0.08em;
  animation: blink-crt 1.4s steps(2, start) infinite;
  box-shadow: 0 0 8px currentColor, 0 0 16px currentColor;
}
@keyframes blink-crt {
  to { opacity: 0.2; }
}
@media (prefers-reduced-motion: reduce) {
  .caret-crt { animation: none; }
}
```

Block character, slow pulse to a dim state (not invisible — CRT phosphor doesn''t fully die between refreshes), with a soft glow at all times.

---

## Concrete examples

### Example A — Ownware hero with terminal caret

Brief: developer-tool landing page. Hero h1 reads as a terminal prompt.

```html
<section class="hero" data-cx-id="hero">
  <p class="kicker">$ ownware init</p>
  <h1>Build agents that live where the user lives.<span class="caret-term" aria-hidden="true"></span></h1>
  <p class="sub">Local-first. No shared OAuth. Your laptop is the host.</p>
</section>
```

```css
.hero { min-height: 80vh; display: grid; place-items: center; text-align: center; padding: 64px; background: #0d1117; color: #e6edf3; }
.hero h1 { font: 600 64px/1.1 ui-monospace, "JetBrains Mono", Menlo, monospace; letter-spacing: -0.01em; max-width: 18ch; margin: 0 0 24px; text-wrap: balance; }
.hero .kicker { font: 500 13px/1 ui-monospace, monospace; letter-spacing: 0.06em; color: #58a6ff; opacity: 0.8; margin: 0 0 16px; }
.hero .sub { font-size: 18px; opacity: 0.7; max-width: 48ch; }
```

### Example B — Ownware hero with iOS caret (chat-input feel) + CRT pixel-deck variant

iOS caret on a sans-serif h1 frames the hero as a chat composer:

```html
<section class="hero" data-cx-id="hero">
  <h1 class="composer">A landing page that finally feels like ours.<span class="caret-ios" aria-hidden="true"></span></h1>
</section>
```

```css
.composer { font: 500 48px/1.2 -apple-system, system-ui, sans-serif; letter-spacing: -0.015em; max-width: 22ch; text-wrap: balance; }
```

For the retro-pixel deck variant, swap `caret-ios` → `caret-crt` and the h1 font to `"Press Start 2P", monospace`. The glow on `.caret-crt` reinforces the CRT-phosphor effect.

---

## Anti-patterns

- **Mixing two caret variants on one page.** Stop. The blink rate of variant A fights the blink rate of variant B. Pick one.
- **Caret in the accent color.** Stop. The caret is `currentColor` — same as the text. An accent-colored caret reads as a notification badge.
- **No `prefers-reduced-motion` override.** Stop. A persistent 1Hz blink on a vestibular-sensitive user is a fail. The reduced-motion branch keeps the caret visible and stops the animation.
- **Px width on the caret.** Stop. The caret scales with `em` so it stays proportional whether the headline is 32px or 96px.
- **Caret announcement to screen readers.** Stop. `aria-hidden="true"` on the caret element. The headline''s text is what the screen reader needs.
- **Adding a third effect on top of the caret (typewriter typing + caret + shimmer).** Stop. The caret IS the motion. Other motion competes; the headline''s eye-attention budget is finite.
