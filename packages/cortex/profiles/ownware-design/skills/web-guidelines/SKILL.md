---
name: web-guidelines
description: Hard numbers for layout, typography, color, motion, and accessibility on the web — the Vercel/Linear/Stripe baseline distilled into a checklist. Use when building any landing page, marketing page, dashboard, or product UI artifact that has to feel competent on first scroll. Skip when the brief is intentionally brutalist or experimental — those break the rules on purpose and should be discussed first.
trigger: /web-guidelines
---

# Web Guidelines — the boring numbers that make a page feel competent

## Overview

There is a baseline every modern product-grade web page hits: 1200px container, 16px body type, 8px spacing scale, 4.5:1 text contrast, 200ms transitions. Miss any of these and the artifact reads "AI-generated" before the user can articulate why. This skill is the cheat sheet — load it before laying out a hero, building a dashboard, or critiquing your own artifact's rhythm.

Use this in tandem with `artifact` (file shape) and `critique` (the rubric). This skill provides the *values*; those skills provide the *structure* and the *audit*.

---

## Critical Constraints — read these first, every time

1. **Container width = 1200px max.** Wider than that and lines of body text become unreadable. Inner side-padding `24px` mobile / `48px` desktop. Center with `margin-inline: auto`.
2. **Body font-size = 16px minimum.** Below 16px iOS Safari zooms inputs on focus and the page becomes a tap-target nightmare. Line-height 1.5–1.65 for body. Heading line-height 1.1–1.2.
3. **Spacing scale = 8px multiples.** Allowed values: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 120. Never `padding: 17px`. Never `margin: 23px`. Snap to the scale.
4. **Section vertical rhythm.** Desktop section padding = 80–96px. Mobile = 48–56px. Same value across every section unless one section is *intentionally* dense.
5. **Contrast bar = WCAG AA.** Body text ≥ 4.5:1 against its surface. Headlines ≥ 3:1 (large text). Primary CTAs aim for AAA (7:1). Test pre-ship with a known calculator value, not a guess.
6. **Motion duration ≤ 300ms.** Hover/focus = 120–160ms. State changes (drawer open, modal in) = 200–250ms. Anything longer feels broken on a fast laptop.
7. **CTA visible without scroll on viewport ≥ 720h.** The primary action must be reachable in the first fold on a 1280×720 laptop screen.

---

## The numeric rubric

### Layout grid

- **Container max-width:** `1200px` for marketing, `1440px` for dashboards.
- **Gutter:** `24px` mobile, `32px` desktop. Set on the container, not on every child.
- **Column model:** 12-col grid for marketing, `grid-template-columns: repeat(12, 1fr); gap: 32px;`. For dashboards, named tracks beat 12-col.
- **Side padding:** `24px` ≤ 640px viewport, `48px` ≥ 768px viewport. Use `clamp(24px, 4vw, 48px)` if you want one rule.
- **Section minimum height:** none for content sections, `min-height: 70vh` only for hero on `> 1024px`.

### Typography scale

Modular scale `1.250` (major third) starting at `16px`. Tokens in `:root`:

```css
--text-xs:   12px;
--text-sm:   14px;
--text-base: 16px;  /* body */
--text-lg:   20px;
--text-xl:   25px;
--text-2xl:  31px;  /* section heading */
--text-3xl:  39px;  /* h2 */
--text-4xl:  49px;  /* h1 marketing */
--text-5xl:  61px;  /* hero on desktop */
--text-6xl:  76px;  /* oversized hero */
```

- **Body:** `16px/1.6`. `text-wrap: pretty` on all body paragraphs.
- **Headings:** `letter-spacing: -0.01em` from `--text-2xl` and up, `-0.02em` from `--text-4xl` and up. `text-wrap: balance` on h1 and h2.
- **Fluid hero size:** `font-size: clamp(40px, 7vw, 76px);` keeps it readable on every viewport.
- **Max measure:** body paragraphs `max-width: 65ch`. Past 65ch, eyes lose the next line.

### Color and contrast

- **Surfaces:** light theme `--bg: #fafafa; --surface: #ffffff;`. Dark theme `--bg: #0a0a0a; --surface: #161616;`.
- **Body text contrast:** `#111` on `#fff` = 18.7:1 (AAA). `#6b7280` on `#fff` = 5.0:1 (AA body, AAA large). `#9ca3af` on `#fff` = 3.0:1 (FAIL for body; OK for >= 18px bold).
- **Accent on white:** `#2f6feb` (cobalt) = 4.7:1 (AA pass). `#5e6ad2` (Linear-ish purple) = 5.2:1. `#7c3aed` (vibrant purple) = 5.0:1.
- **Focus ring:** 2px solid `var(--accent)`, `outline-offset: 2px`. Never `outline: none` without a replacement.
- **State colors:** success `#16a34a`, warn `#d97706`, danger `#dc2626`. Always pair with an icon — color alone is not an affordance.

### Motion durations

- **Micro (hover, focus, small state):** 120ms ease-out.
- **Standard (modal in, drawer open, card flip):** 200–250ms cubic-bezier(0.23, 1, 0.32, 1).
- **Exit (dismiss):** 140ms cubic-bezier(0.4, 0, 1, 1). Always faster than the enter.
- **Page transitions:** ≤ 300ms. Anything longer feels like loading, not animation.
- **Loops (spinners, breathing UI):** infinite, 1.5s minimum cycle, opacity-only or transform-only — never both layered.

### Tap and click targets

- **Minimum target:** `44×44px` (Apple), `48×48dp` ≈ 48px (Android). On web, use `min-height: 44px` for buttons and `min-height: 40px` for inline inputs (with 8px padding around the visible affordance to reach 44px hit-area).
- **Tap target spacing:** ≥ 8px between two interactive elements. Side-by-side icon buttons need 12–16px gap.

### Z-index scale

Use a fixed scale; never `z-index: 9999`.

```css
--z-base:     0;
--z-dropdown: 100;
--z-sticky:   200;
--z-overlay:  300;
--z-modal:    400;
--z-toast:    500;
```

---

## Concrete examples

### Example 1 — Hero block (Modern Minimal direction)

```html
<section data-cx-id="hero" style="
  padding: clamp(64px, 12vw, 120px) clamp(24px, 4vw, 48px);
  max-width: 1200px;
  margin-inline: auto;
">
  <h1 style="
    font-size: clamp(40px, 7vw, 76px);
    line-height: 1.05;
    letter-spacing: -0.02em;
    text-wrap: balance;
    max-width: 18ch;
    margin: 0 0 24px;
  ">Move money like a developer.</h1>

  <p style="
    font-size: 20px;
    line-height: 1.5;
    color: var(--muted);
    max-width: 56ch;
    text-wrap: pretty;
    margin: 0 0 32px;
  ">The financial platform built for software people. APIs, webhooks, idempotency keys — no PDFs.</p>

  <a href="#cta" style="
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: 0 24px;
    background: var(--accent);
    color: var(--accent-fg);
    border-radius: 8px;
    font-weight: 500;
    transition: background 120ms ease-out;
  ">Start building</a>
</section>
```

Everything snaps to the scale: 24, 32, 48px. Hero is `clamp`ed across viewports. `text-wrap: balance` on h1. CTA is 48px tall, AA-pass color.

### Example 2 — A dashboard KPI row

- Container width `1440px`, side padding `32px`.
- KPI cards `min-width: 240px; padding: 20px 24px; border-radius: 12px;`.
- KPI number `--text-3xl` (39px), bold, `letter-spacing: -0.02em`.
- KPI label `--text-sm` (14px), `color: var(--muted)`, uppercase, `letter-spacing: 0.08em` (small caps treatment).
- Grid: `grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px;` — one rule, responsive without media queries.

---

## Anti-patterns

- **Reaching for random pixel values.** Stop. Snap to 4/8/12/16/24/32/48. If `19px` feels right, use `20px`.
- **`font-size: 14px` on body for "minimal" look.** Stop. 16px minimum. The user is on a phone, not your 4K monitor.
- **`outline: none` on `:focus`.** Stop. Replace with `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`.
- **`transition: all 500ms`.** Stop. Specify the property and use ≤ 300ms.
- **Pure `color` for state indication.** Stop. Add an icon or shape. 8% of men can't distinguish red/green reliably.
- **Container `max-width: 100%` on a marketing page.** Stop. Body lines become unreadable past 1200px. Cap it.
- **`z-index: 9999`.** Stop. Use the scale. Stacking wars compound.
