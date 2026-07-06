---
name: dark-mode-craft
description: 'Dual-theme rules beyond simple L-inversion — surface elevation flips, body-text lightness bumps, accent OKLCH shifts, photo desaturation, border alpha, glow-not-drop shadows. Use when adding a dark variant, shipping a dark-only artifact, or when an existing dark mode feels washed out / vibrating / halating. Pairs with /color-system. Skip for light-only briefs or a single-token swap.'
trigger: /dark-mode-craft
---

# Dark Mode Craft — six rules that are NOT inversion

## Overview

Dark mode done badly is light mode with `--bg` and `--fg` swapped. The result looks fine in Figma and feels wrong on a real screen at midnight: white body text halates, drop shadows disappear into the void, neutrals lose family, accents either neon-vibrate or fade into the panel. This skill is the six rules that separate "I flipped two tokens" from "I designed a dark theme."

Use this after `/color-system` has produced a palette, OR when retrofitting dark onto an existing light artifact. Skip when the user said "make the background black" — that's a token swap, not a system.

---

## Critical Constraints — read these first

1. **Dark mode is its own palette, not an inverted one.** Light-mode `--bg L 0.98` does NOT become dark-mode `--bg L 0.02`. The spread is asymmetric on purpose — see rules below.
2. **Never pure `#FFFFFF` for body text on dark.** Pure white at L 1.0 halates on OLED and high-contrast LCDs; the eye sees a faint glow around every letter. Use L 0.90-0.93 (`#E8E8E8`-ish).
3. **Surface elevation flips direction, but the principle is the same: higher = lighter.** Light mode: `--bg #FAFAFA → --surface #FFFFFF → --elevated #FFFFFF + shadow`. Dark mode: `--bg #0E0E0E → --surface #1A1A1A → --elevated #232323`. Elevation reads as "more light hits this." That stays true in both themes.
4. **Saturated accents need an OKLCH L shift, not a hex tweak.** A `#5E6AD2` Linear-purple that reads beautifully on light becomes muddy on dark. Bump L by +0.05-0.08 in OKLCH (same H, same C) — that's the move.
5. **Photos and screenshots get a -10% saturation overlay in dark mode.** Untreated full-color photos pop too hard against a dark surrounding; they look like they came from a different page. Apply `filter: saturate(0.9) brightness(0.95)` or a `--image-tint` overlay.
6. **Shadows come from glow, not drop.** A `box-shadow: 0 4px 12px rgba(0,0,0,0.1)` is invisible on `#0E0E0E`. Dark-mode elevation uses subtle inset highlights and outer rim glows: `box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 0 0 1px rgba(255,255,255,0.06)`.

---

## The six rules — with numbers

### Rule 1 — Surface elevation: lighter as it elevates (same as light, opposite hex)

The principle "elevated surfaces catch more light" is identical in both themes. Only the absolute values flip.

| Layer | Light mode L | Dark mode L | Light hex | Dark hex |
|-------|--------------|-------------|-----------|----------|
| `--cx-bg` (page) | 0.98 | 0.08 | `#FAFAFA` | `#0E0E0E` |
| `--cx-surface` (card) | 1.00 | 0.13 | `#FFFFFF` | `#1A1A1A` |
| `--cx-elevated` (popover, modal, dropdown) | 1.00 + drop-shadow | 0.18 | `#FFFFFF` | `#232323` |
| `--cx-sunken` (input, code block) | 0.96 | 0.06 | `#F3F3F3` | `#0A0A0A` |

The spread on light is tight (0.96 → 1.00, range 0.04). The spread on dark is wider (0.06 → 0.18, range 0.12) because the eye needs more delta to distinguish layers on a dark base.

### Rule 2 — Body text: bump +0.10 L, never pure white

Light mode `--cx-fg: #1F1F1F` (L ≈ 0.20). Naive inversion gives `#E0E0E0` (L ≈ 0.88). That's slightly too dim on a dark background and reads "low contrast" even though the math passes. Correct value: L 0.92 ≈ `#E8E8E8`.

Never `#FFFFFF` body text. The L 1.0 → L 0.08 contrast is 18.5:1, but the eye perceives halation around every glyph on OLED. Cap at L 0.93 unless it's a single oversized hero word.

| Token | Light hex | Light L | Dark hex | Dark L |
|-------|-----------|---------|----------|--------|
| `--cx-fg` (body) | `#1F1F1F` | 0.20 | `#E8E8E8` | 0.92 |
| `--cx-fg-strong` (h1, h2) | `#0A0A0A` | 0.08 | `#F5F5F5` | 0.96 |
| `--cx-muted` (caption, secondary) | `#6B6B6B` | 0.50 | `#A8A8A8` | 0.72 |

Contrast on `--cx-bg`:
- Light: `#1F1F1F` on `#FAFAFA` = 14.2:1.
- Dark: `#E8E8E8` on `#0E0E0E` = 14.6:1. Matched perception, not matched L.

### Rule 3 — Accents shift +0.05-0.08 OKLCH lightness

Same hue (H), same chroma (C), bumped L. The accent must remain readable on the dark surface.

Worked: Linear-style purple.
- Light mode: `oklch(0.55 0.18 280)` ≈ `#5E6AD2`. Contrast on `#FAFAFA` = 5.2:1. Good.
- Dark mode (naive): `#5E6AD2` on `#0E0E0E` = 4.8:1. Passes barely, looks muddy.
- Dark mode (correct): `oklch(0.62 0.17 280)` ≈ `#7B85DC`. Contrast on `#0E0E0E` = 7.1:1. Lifts off the surface.

For accent-fg (text on accent button):
- Light: usually `#FFFFFF` works (the accent is the dark side of the pair).
- Dark: depends on the accent's L. If accent L ≥ 0.65, the accent itself is bright enough that you need a *dark* `--cx-accent-fg` (`#0A0A0A`). If accent L stays 0.55-0.65, white still works.

### Rule 4 — Photos and imagery: -10% saturation, -5% brightness

Full-color photos and screenshots look out-of-place against `#0E0E0E` — they read as a hole punched in the page. Two options:

**Option A — global filter on all media:**
```css
.dark img:not(.no-tint),
.dark video,
.dark svg.illustration {
  filter: saturate(0.9) brightness(0.95);
}
```

**Option B — CSS overlay layer (preserves the original asset):**
```css
.dark .image-wrap {
  position: relative;
}
.dark .image-wrap::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(14, 14, 14, 0.08);
  pointer-events: none;
}
```

Logos with brand color should keep their saturation — exempt them with `.no-tint`. Decorative photos and screenshots get the treatment.

### Rule 5 — Borders use higher alpha, not solid colors

Light mode borders: solid hex like `#E5E5E5` works (8-10% alpha equivalent over white).
Dark mode borders: solid hex like `#2A2A2A` exists but `rgba(255, 255, 255, 0.12)` is better — it adapts to the layer beneath it.

| Border kind | Light mode | Dark mode |
|-------------|-----------|-----------|
| Hairline (table row, divider) | `#E5E5E5` (8% black-equiv) | `rgba(255, 255, 255, 0.08)` |
| Standard (card, input) | `#D4D4D4` (12% black-equiv) | `rgba(255, 255, 255, 0.12)` |
| Strong (focus, selected) | `#A8A8A8` (24% black-equiv) | `rgba(255, 255, 255, 0.20)` |

The "12-16% alpha" rule: dark-mode borders need 1.4-1.6x the alpha of light-mode borders to register at equivalent perceptual weight. White-alpha overlays beat solid hex because they layer correctly when you stack a popover (`--cx-elevated`) on a card (`--cx-surface`).

### Rule 6 — Shadows come from glow, not drop

A `box-shadow: 0 4px 12px rgba(0, 0, 0, 0.10)` makes a card pop on `#FFFFFF`. On `#0E0E0E` the same shadow is invisible — you can't be darker than the background.

Dark mode elevation comes from:

1. **Inner top highlight** — `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06)` — simulates light catching the top edge.
2. **Rim glow** — `box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06)` — outlines the card without a solid border.
3. **Subtle outer drop, mostly for depth** — `box-shadow: 0 8px 24px rgba(0, 0, 0, 0.40)` — still useful for popovers and modals, but lower elevation cards (default state) skip it.

Combined elevation shadow for a popover in dark mode:

```css
.popover {
  background: var(--cx-elevated);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 0 0 1px rgba(255, 255, 255, 0.08),
    0 12px 32px rgba(0, 0, 0, 0.50);
}
```

---

## Ownware token block — both themes side by side

Paste-ready into `:root` and `[data-theme="dark"]`:

```css
:root {
  /* surfaces */
  --cx-bg: #FAFAFA;
  --cx-surface: #FFFFFF;
  --cx-elevated: #FFFFFF;
  --cx-sunken: #F3F3F3;

  /* text */
  --cx-fg: #1F1F1F;
  --cx-fg-strong: #0A0A0A;
  --cx-muted: #6B6B6B;

  /* borders */
  --cx-border: rgba(0, 0, 0, 0.10);
  --cx-border-strong: rgba(0, 0, 0, 0.20);

  /* accents — Ownware defaults */
  --cx-violet: oklch(0.55 0.18 290);     /* ≈ #6E59E0 */
  --cx-teal:   oklch(0.62 0.13 195);     /* ≈ #2FA5B6 */
  --cx-rose:   oklch(0.58 0.20 15);      /* ≈ #E15569 */
  --cx-accent: var(--cx-violet);
  --cx-accent-fg: #FFFFFF;

  /* elevation */
  --cx-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 12px rgba(0, 0, 0, 0.04);
  --cx-shadow-popover: 0 8px 24px rgba(0, 0, 0, 0.12);
}

[data-theme="dark"] {
  /* surfaces — wider L spread */
  --cx-bg: #0E0E0E;
  --cx-surface: #1A1A1A;
  --cx-elevated: #232323;
  --cx-sunken: #0A0A0A;

  /* text — +0.10 L, never pure white */
  --cx-fg: #E8E8E8;
  --cx-fg-strong: #F5F5F5;
  --cx-muted: #A8A8A8;

  /* borders — white-alpha at 1.4x light */
  --cx-border: rgba(255, 255, 255, 0.12);
  --cx-border-strong: rgba(255, 255, 255, 0.20);

  /* accents — +0.07 L from light */
  --cx-violet: oklch(0.62 0.17 290);     /* ≈ #8779E8 */
  --cx-teal:   oklch(0.70 0.12 195);     /* ≈ #58BFCC */
  --cx-rose:   oklch(0.66 0.18 15);      /* ≈ #ED7280 */
  --cx-accent: var(--cx-violet);
  --cx-accent-fg: #FFFFFF;

  /* elevation — inner highlight + rim glow */
  --cx-shadow-card:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 0 0 1px rgba(255, 255, 255, 0.06);
  --cx-shadow-popover:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 0 0 1px rgba(255, 255, 255, 0.08),
    0 12px 32px rgba(0, 0, 0, 0.50);
}
```

---

## Concrete examples

### Example 1 — A card component in both themes

Same component, two themes, no markup change. The difference is entirely in the tokens.

```html
<article class="card" data-cx-id="feature-card">
  <h3>Idempotent webhooks</h3>
  <p>Retry safely. Every request carries a key; duplicate deliveries return the original response.</p>
  <a href="/docs" class="card-link">Read the docs →</a>
</article>

<style>
.card {
  background: var(--cx-surface);
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--cx-shadow-card);
}
.card h3 {
  color: var(--cx-fg-strong);
  font-size: 18px;
  margin: 0 0 8px;
}
.card p {
  color: var(--cx-muted);
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 16px;
}
.card-link {
  color: var(--cx-accent);
  text-decoration: none;
  font-weight: 500;
}
</style>
```

What changes between themes (no markup edits):

| Element | Light value | Dark value | Why |
|---------|-------------|------------|-----|
| `.card` bg | `#FFFFFF` | `#1A1A1A` | Surface elevation lifts from `--cx-bg` |
| `.card` shadow | drop-shadow on white bg | inset + rim glow on dark bg | Drop-shadow invisible on `#0E0E0E` |
| `h3` color | `#0A0A0A` | `#F5F5F5` | Strong fg, never pure white |
| `p` color | `#6B6B6B` (L 0.50) | `#A8A8A8` (L 0.72) | Muted bumped +0.22 L for parity, not inverted |
| `.card-link` color | `#6E59E0` (L 0.55) | `#8779E8` (L 0.62) | Accent +0.07 L to lift off dark surface |

### Example 2 — A hero photo with the right treatment

```html
<section class="hero" data-cx-id="hero">
  <div class="hero-text">
    <h1>Books that build cathedrals.</h1>
    <p>A reading list for software people who want to think bigger.</p>
  </div>
  <div class="hero-image image-wrap">
    <img src="./hero.jpg" alt="Stack of books on a dark wood table" />
  </div>
</section>

<style>
.image-wrap { position: relative; border-radius: 16px; overflow: hidden; }
.image-wrap img { display: block; width: 100%; height: auto; }

[data-theme="dark"] .image-wrap img {
  filter: saturate(0.9) brightness(0.95);
}
[data-theme="dark"] .image-wrap::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(14, 14, 14, 0.06);
  pointer-events: none;
}
</style>
```

The photo no longer reads as a "hole" punched in the page — it sits in the dark surround. The brand-color logo elsewhere on the page would be marked `<img class="no-tint">` to keep its full saturation.

---

## Anti-patterns

- **Inverting L mechanically.** `--cx-bg: #FAFAFA` (L 0.98) becoming `#020202` (L 0.02) in dark mode gives a pitch-black bg that fights every shadow and a 18.7:1 contrast that vibrates. Use L 0.08-0.10, never pure black.
- **Pure `#FFFFFF` body text.** Halates on OLED. Use `#E8E8E8` (L 0.92) for body and reserve `#F5F5F5` for strong headings only.
- **Same accent hex in both themes.** A `#5E6AD2` purple drops below `--cx-fg-strong` perceived weight on dark and looks faded. Bump L by 0.05-0.08 in OKLCH; same H, same C.
- **Drop-shadows in dark mode.** `box-shadow: 0 4px 12px rgba(0,0,0,0.1)` is invisible on `#0E0E0E`. Switch to inner-highlight + rim-glow.
- **Solid hex borders in dark mode.** `border: 1px solid #2A2A2A` works in isolation but breaks when you nest a popover on a card on a bg. Use `rgba(255, 255, 255, 0.12)` so it composes correctly across layers.
- **Untreated full-color photos.** A vibrant magazine cover image at full saturation against `#0E0E0E` looks pasted in. Apply `filter: saturate(0.9) brightness(0.95)` or accept the visual rupture.
- **One token block toggled by class with no semantic separation.** If you have to override 40 individual rules in `[data-theme="dark"]`, the system is wrong. Tokens flip; rules reference tokens. Period.
