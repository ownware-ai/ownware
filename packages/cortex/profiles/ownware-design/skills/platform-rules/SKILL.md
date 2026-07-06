---
name: platform-rules
description: Cross-platform design baselines — when an artifact has to look right on iOS, Android, and web at once. Distills Apple HIG, Material Design 3, and WCAG 2.2 into the load-bearing numbers (spacing scales, tap targets, type minimums, contrast ratios, motion). Use when the brief names "iOS app", "Android app", "mobile mock", or "cross-platform". Skip for pure marketing pages — use web-guidelines instead.
trigger: /platform-rules
---

# Platform Rules — pick a baseline for iOS, Android, or web

## Overview

There are three real systems people ship into: Apple's HIG (iOS / iPadOS / macOS), Material Design 3 (Android / web), and the accessibility floor WCAG 2.2. They agree on more than they disagree, but the spacing scales, tap target minimums, and motion grammars differ enough that "I'll just eyeball it" produces a mock that looks wrong on every platform at once. This skill is the decision tree: pick the platform, snap to its scale, hit the WCAG floor, move on.

If the brief is a marketing landing page, use `web-guidelines` instead — that has the web-specific numbers. This skill is for *product* surfaces that mirror a native app's vocabulary.

---

## Critical Constraints — read these first, every time

1. **Pick the baseline first, then build.** "iOS-style" → Apple 4pt grid. "Material" / "Android" → Material 8dp grid. "Cross-platform web" → 8px grid (compatible with both). Don't mix scales mid-artifact.
2. **Tap targets are non-negotiable.** iOS ≥ 44pt. Android ≥ 48dp. Web ≥ 44px. Smaller than that and the user mis-taps.
3. **Body text ≥ 17pt (iOS), ≥ 14sp (Android body large), ≥ 16px (web).** Below those values is illegible on a phone held at arm's length.
4. **WCAG 2.2 floor applies everywhere.** 4.5:1 body contrast, 3:1 large text, 3:1 UI components and graphic objects. No platform exempts you from this.
5. **Motion grammar differs.** Apple = 250–400ms with `cubic-bezier(0.4, 0, 0.2, 1)` ease-out. Material = 200–300ms standard, durations chosen from a token scale (`short4`, `medium2`, etc.). Pick one and stay.

---

## The decision tree — which baseline?

Answer the first question that applies:

1. **Brief says "iOS" / "iPhone" / "iPad" / "macOS" / "SwiftUI feel"** → Apple HIG. Use the 4pt grid, SF system font stack, Apple motion, 44pt tap target.
2. **Brief says "Android" / "Material" / "Material 3" / "Google" / "Jetpack Compose feel"** → Material Design 3. Use the 8dp grid, Roboto / Inter, Material motion tokens, 48dp tap target.
3. **Brief says "cross-platform" / "PWA" / "responsive web app that should also work on mobile"** → 8px grid + web stack (`system-ui` / `Inter`), 44px tap target, WCAG body contrast, Material-leaning motion (it composes more cleanly with CSS transitions than Apple's curves).
4. **No platform named, but it's a mobile mock** → default to iOS HIG. iOS is the higher-craft default; Material is the answer when explicitly requested.

---

## Rubric — Apple HIG (4pt grid)

- **Spacing scale (pt):** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80. Component padding 12–20pt, screen gutter 16–20pt.
- **Tap targets:** ≥ 44pt × 44pt for any tappable affordance. Bar buttons 44pt high; tab bar items 49pt high.
- **Type ramp (Dynamic Type defaults):** Large Title 34pt, Title 1 28pt, Title 2 22pt, Title 3 20pt, Headline 17pt semibold, Body 17pt, Callout 16pt, Subhead 15pt, Footnote 13pt, Caption 12pt.
- **Font stack:** `-apple-system, "SF Pro Text", "SF Pro Display", system-ui, sans-serif`. Use SF Pro Display ≥ 20pt, SF Pro Text below 20pt.
- **Radii:** 8pt for buttons, 12pt for cards, 16pt for sheets, **continuous** rounded corners on iOS 13+ (CSS: `border-radius` is square-corner; for the iOS continuous curve in web mocks, use `border-radius: 16px` and accept the approximation, or render an SVG mask).
- **Motion:** standard 250–350ms ease-out (`cubic-bezier(0.4, 0, 0.2, 1)`), spring physics for sheets and modals. Avoid linear curves.
- **Color:** support light + dark mode. Tint color on system blue `#007AFF` (light) / `#0A84FF` (dark). Body text 100% opacity, secondary 60% opacity, tertiary 30% opacity.
- **Status bar / safe area:** account for `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` in web mocks of full-screen iOS layouts.

## Rubric — Material Design 3 (8dp grid)

- **Spacing scale (dp):** 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64. Component padding 12–24dp, screen gutter 16–24dp.
- **Tap targets:** ≥ 48dp × 48dp. App bar 64dp tall, FAB 56dp, navigation rail items 48dp.
- **Type ramp (M3 type scale):** Display Large 57sp, Display Medium 45sp, Display Small 36sp, Headline Large 32sp, Headline Medium 28sp, Headline Small 24sp, Title Large 22sp, Title Medium 16sp, Body Large 16sp, Body Medium 14sp, Label Large 14sp, Label Small 11sp.
- **Font stack:** `"Roboto", "Roboto Flex", "Inter", system-ui, sans-serif`. Use Roboto Flex if variable fonts available.
- **Radii (M3 shape scale):** none 0, extra-small 4dp, small 8dp, medium 12dp, large 16dp, extra-large 28dp. Cards default to medium; FAB extra-large.
- **Motion tokens:** standard duration 200–300ms with `cubic-bezier(0.2, 0, 0, 1)` (M3 emphasized). Short = 50–200ms, medium = 250–400ms, long = 450–600ms. Pick from the scale; don't free-form.
- **Color (M3 dynamic color):** generate from a single source color via M3 palettes. Primary, on-primary, primary-container, on-primary-container — four tokens per role. Surface tonal elevation: surface, surface-1 through surface-5 (each step ~5% lightness delta).
- **Elevation:** M3 uses *tonal elevation* (surface tint via opacity) and *shadow elevation*. Default cards `elevation-1` (1dp tonal + subtle shadow). FAB `elevation-3`. Don't stack 8dp shadows — that's old Material 2.

## Rubric — WCAG 2.2 floor (applies to all three above)

- **Contrast:** body text 4.5:1, large text (≥ 18pt regular / ≥ 14pt bold) 3:1, UI components and graphical objects 3:1.
- **Tap target:** 24×24 CSS px minimum *non-text* target (2.5.8, AA). Hit 44px for AAA and parity with HIG.
- **Focus visible:** every focusable element has a visible focus state, ≥ 2px wide, ≥ 3:1 contrast with adjacent colors (2.4.11 AA).
- **Text resize:** content reflows up to 200% zoom without horizontal scroll on 320px viewport (1.4.10 AA).
- **No motion-only meaning:** if motion conveys info, provide a static equivalent. Respect `prefers-reduced-motion: reduce` — drop animation duration to ≤ 100ms or disable.

---

## Concrete examples

### Example 1 — iOS settings row in a web mock

```html
<div data-cx-id="settings-row" style="
  display: flex; align-items: center; gap: 12px;
  min-height: 44px;            /* HIG tap target */
  padding: 12px 20px;            /* 4pt grid */
  background: var(--surface);
  border-bottom: 0.5px solid var(--border);
  font: 17px/1.4 -apple-system, system-ui;  /* HIG Body */
">
  <span style="flex: 1;">Notifications</span>
  <span style="color: var(--muted); opacity: 0.6;">On ›</span>
</div>
```

Why: 44px tap target, 17px Body type, SF system stack, 0.5px hairline divider (an iOS signature), 60% opacity for secondary text.

### Example 2 — Material 3 FAB in a web mock

```html
<button data-cx-id="fab-create" style="
  width: 56px; height: 56px;     /* M3 FAB */
  border-radius: 16px;            /* M3 extra-large shape */
  background: var(--primary);
  color: var(--on-primary);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08);  /* elevation-3 approx */
  border: none;
  display: grid; place-items: center;
  transition: background 200ms cubic-bezier(0.2, 0, 0, 1);
">
  <svg width="24" height="24" /* M3 icon size */>…</svg>
</button>
```

Why: 56dp size, M3 extra-large radius (16dp), 24dp icon, M3 motion curve and duration, elevation via shadow tokens (not arbitrary blur).

### Example 3 — Cross-platform card (web + works on mobile)

- Width: `min(100%, 360px)`, padding 16px, gap 12px, radius 12px.
- Heading: 18px / 1.3 / 600 weight. Body: 14px / 1.5 / 400.
- Tap targets inside: every action ≥ 44px square.
- Color contrast: heading at `#111` on `#fff` (18.7:1), body at `#4b5563` (8.6:1), captions at `#6b7280` (5.0:1).
- Motion: hover `transform: translateY(-2px); transition: 200ms ease-out;` — Material-leaning duration, composes cleanly on web.

---

## Anti-patterns

- **Mixing 4pt and 8dp scales in one artifact.** Stop. Pick one. The eye reads inconsistency as broken.
- **`min-height: 32px` on a button "to look more compact".** Stop. The user's thumb is wider than 32px. Use 44px and let the typography sell the compact look.
- **Generic `box-shadow: 0 4px 12px rgba(0,0,0,0.1)` on iOS-styled cards.** Stop. iOS uses subtle elevation; Material uses layered shadows with tonal tint. Match the platform's grammar.
- **`transition: all 0.3s linear`.** Stop. Linear is for progress bars only. Use ease-out curves from the platform's token set.
- **Color-only state (red error / green success).** Stop. Add an icon and a label. WCAG 1.4.1 requires it.
- **Ignoring `prefers-reduced-motion`.** Stop. Wrap non-essential animation in `@media (prefers-reduced-motion: no-preference)`.
