---
name: design-system-builder
description: 'Build a brand-from-zero design system — tokens, type stack, component rules, voice — when nothing in the catalog fits. Outputs a single `:root` block plus a one-page DESIGN.md the artifact skill can paste from. Use when the user wants something genuinely new ("design from scratch", brand kickoff, no reference URL works). Do NOT use when the catalog has a close match — `apply_design_system` is faster and the catalog entry is already curated.'
trigger: /design-system-builder
---

# Design System Builder — brand from zero, in one pass

## Overview

When the catalog has nothing, when the user's brand has no precedent, when a reference URL would be misleading — build the system end-to-end here. The output is two things: a `:root` token block ready to paste into an artifact's first `<style>`, and a one-page `DESIGN.md` describing the rules a future agent (or you, next turn) needs to extend the system without drifting.

Use this for brand workshops, "design me something nobody's done before," and net-new product brands. Skip it whenever `list_design_systems` returns a candidate that the user nods at — that path is faster and the catalog entries are already road-tested.

---

## Critical Constraints

1. **Check the catalog first, every time.** Call `list_design_systems({ search: <best keyword> })` before building from zero. The catalog is the cheap path. Only proceed here if the catalog returns nothing close OR the user explicitly said "from scratch".
2. **One accent only at the system level.** A new brand earns ONE accent hue and a five-stop ramp. Adding a second accent ("primary purple AND secondary teal") almost always means the brief actually wants two systems. Push back before adding the second.
3. **Tokens before components.** Resolve the full `:root` block first. Component CSS is downstream. Never write a button rule that references a hardcoded hex — every component must read `var(--…)`.
4. **AA contrast, always.** Body `--fg` on `--bg` ≥ 7:1 (AAA). Accent on `--bg` ≥ 4.5:1 (AA non-text). Buttons (`--accent-fg` on `--accent`) ≥ 4.5:1. If a chosen accent fails, darken or lighten it until it passes — do not ship a system that fails contrast.
5. **Type stack is two faces, plus mono.** One display, one body, one mono utility. A third face is a smell — kill it or justify it.
6. **Output is two files.** A `:root` block (paste-ready CSS) and a one-page `DESIGN.md` written so the next agent (or the artifact skill, this turn) can extend without re-asking.
7. **Document the why on every choice.** Every token in DESIGN.md gets a one-line rationale. "Why is `--accent: #5e6ad2`?" — "Anchors the brand to a known-good purple from the modern-minimal direction; passes 4.6:1 on `--bg: #fafafa`."

---

## Framework — the eight decisions, in order

Resolve these in this order. Each decision constrains the next; reversing the order causes rework.

1. **Direction archetype** — pick ONE of the five fallback archetypes (Editorial Monocle, Modern Minimal, Warm Soft, Tech Utility, Brutalist Experimental) as the substrate. Even brand-from-zero starts from an archetype; the brand layer is overrides on top.
2. **Accent hue** — one OKLCH hue between 250 and 320 (cool) or 20 and 60 (warm). Saturation 0.12-0.20 for B2B, 0.18-0.26 for consumer. Verify accessibility.
3. **Surface ramp** — `--bg`, `--surface`, `--surface-2`. Three steps. Light mode: L ≈ 0.98, 1.00, 0.96. Dark mode: L ≈ 0.08, 0.12, 0.16.
4. **Text ramp** — `--fg` (body), `--muted` (secondary). Light mode: L ≈ 0.15 for fg, 0.45 for muted. Dark mode: L ≈ 0.92 for fg, 0.62 for muted. Always check contrast against bg.
5. **Type stack** — display face + body face + mono. See Section 2.
6. **Density** — radius scale, padding scale, line-height scale. See Section 3.
7. **Semantic colors** — `--good`, `--warn`, `--bad`. Three steps. Tuned so they don't fight the accent.
8. **Component baseline** — buttons, cards, inputs, links. Three component rules that establish the system. See Section 4.

---

## 1. Accent generation — OKLCH first, hex second

Pick the hue in OKLCH because RGB lies about lightness. A `#3b82f6` (cobalt) and a `#10b981` (emerald) look different lightnesses to the eye even though they're "the same blue value." OKLCH separates lightness from hue so two accents render as visually-equivalent emphasis.

**Workflow:**

1. Pick the hue in degrees (0-360). Cool brands: 220-280. Warm: 20-50. Earthy: 80-120. Vibrant: 0-20 or 280-320.
2. Pick lightness L for the accent itself: 0.55-0.65 on light backgrounds (`--bg ≈ L 0.98`), 0.65-0.75 on dark backgrounds.
3. Pick chroma C: 0.15-0.22 for most brands; 0.08-0.12 for muted/restrained brands; 0.22+ for vibrant brands.
4. Generate a five-stop ramp at L = 0.10, 0.25, 0.55, 0.75, 0.92 for hover / pressed / focus tints. Same hue, same chroma, varying lightness.
5. Convert to hex at the end (browsers support `oklch()` directly in modern CSS but tokens still ship as hex for compatibility).

**Verify before shipping:**

- `--accent` on `--bg` ≥ 4.5:1 (AA for non-text)
- `--accent-fg` on `--accent` ≥ 4.5:1 (AA for button text)
- `--accent` on `--surface` ≥ 3:1 (AA for large text and UI components)

If any fail, adjust L by ±0.05 and re-check. Hue stays.

---

## 2. Type stack — two faces, deliberate pairing

Display face does headlines; body face does paragraphs. They should differ in personality but agree in proportion (x-height ratio).

| Brand feel | Display | Body | Mono |
|------------|---------|------|------|
| Editorial | "Iowan Old Style", Georgia, "Times New Roman", serif | "Inter", -apple-system, system-ui, sans-serif | ui-monospace, "JetBrains Mono", Menlo, monospace |
| Modern restrained | "Inter Display", "Inter", -apple-system, sans-serif | "Inter", -apple-system, system-ui, sans-serif | ui-monospace, "JetBrains Mono", Menlo, monospace |
| Warm humanist | "Fraunces", "Iowan Old Style", Georgia, serif | "Inter", -apple-system, system-ui, sans-serif | ui-monospace, "JetBrains Mono", Menlo, monospace |
| Technical | "IBM Plex Sans", -apple-system, sans-serif | "IBM Plex Sans", -apple-system, sans-serif | "IBM Plex Mono", ui-monospace, monospace |
| Bold/Brutalist | "Times New Roman", Georgia, serif (display sizes only — counter-intuitive but works) | -apple-system, "Helvetica Neue", Arial, sans-serif | ui-monospace, monospace |

**Rules:**

- Always stack with system-ui fallbacks; never depend on a single web font loading. If the brand font fails to load, the artifact still renders.
- Display sizes: clamp(2rem, 5vw, 4rem) for h1, clamp(1.5rem, 3vw, 2.25rem) for h2.
- Body size: 14-16px desktop, 16px mobile minimum.
- Line-height: 1.2 for display, 1.5-1.6 for body, 1.35 for table/data dense.
- Letter-spacing: `-0.01em` on display ≥ 32px; default on body; `0.02em` on uppercase labels.

---

## 3. Density scale — radius + padding + spacing

Three density profiles. Pick ONE and apply it consistently. Mixing density profiles is the #1 source of "this looks off."

| Density | Radius | Card padding | Section padding (desktop / mobile) | Gutters |
|---------|--------|--------------|-----------------------------------|---------|
| Spacious | 12-16px | 28-40px | 120 / 64px | 32px |
| Balanced | 8-10px | 16-24px | 80 / 48px | 24px |
| Dense | 4-6px | 8-14px | 48 / 32px | 16px |

Scale: pick the base unit (4px or 8px) and stick to multiples. Padding 14px is fine if the base is 2px (rare); 14px with an 8px base is drift — round to 16px.

---

## 4. Component baseline — three rules, every system

A design system isn't real until you've shipped these three components. Every other component is a variation on these.

### Button

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-radius: var(--radius);
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 14px;
  line-height: 1;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.btn-primary {
  background: var(--accent);
  color: var(--accent-fg);
}
.btn-primary:hover { background: var(--accent-hover); }
.btn-secondary {
  background: transparent;
  color: var(--fg);
  border-color: var(--border);
}
.btn-secondary:hover { background: var(--surface); }
.btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

### Card

```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
}
.card-title { font-family: var(--font-display); font-size: 18px; margin: 0 0 8px; }
.card-body { color: var(--muted); font-size: 14px; line-height: 1.6; margin: 0; }
```

### Input

```css
.input {
  width: 100%;
  padding: 10px 14px;
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font: 14px/1.5 var(--font-body);
}
.input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.input::placeholder { color: var(--muted); }
```

Once these three render correctly with your tokens, every other component follows.

---

## Concrete examples

### Example 1 — brand from zero for a developer telemetry tool

**Brief:** "Build me a new brand for a developer observability tool. Not Datadog (too corporate), not Honeycomb (too playful). Should feel like a precision instrument."

**Decisions:**

1. Direction archetype: Tech Utility (dark substrate, dense).
2. Accent hue: OKLCH(0.70 0.16 200) — cool teal. Hex: `#5cb3c4`. Sits between cobalt (overused) and emerald (consumer feel).
3. Surface ramp: `--bg: #0a0d10` (L ≈ 0.06), `--surface: #12161b` (L ≈ 0.10), `--surface-2: #1a1f26` (L ≈ 0.14).
4. Text ramp: `--fg: #e6edf3` (contrast 14.5:1, AAA), `--muted: #8a96a3` (contrast 4.8:1, AA).
5. Type stack: display + body both `"IBM Plex Sans"`. Mono `"IBM Plex Mono"` for the data tables that this product will need.
6. Density: dense (radius 6px, card padding 12px, section padding 48/32px).
7. Semantic: `--good: #56d985`, `--warn: #e8b339`, `--bad: #f06e6e`.
8. Baseline components — buttons read as glyphs not shouts; cards have hairline 1px borders, no shadows.

**Output `:root`:**

```css
:root {
  --bg: #0a0d10;
  --surface: #12161b;
  --surface-2: #1a1f26;
  --fg: #e6edf3;
  --muted: #8a96a3;
  --border: #232a33;
  --accent: #5cb3c4;
  --accent-hover: #4ea1b2;
  --accent-fg: #0a0d10;
  --good: #56d985;
  --warn: #e8b339;
  --bad: #f06e6e;
  --radius: 6px;
  --radius-pill: 999px;
  --font-display: "IBM Plex Sans", -apple-system, system-ui, sans-serif;
  --font-body: "IBM Plex Sans", -apple-system, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "JetBrains Mono", monospace;
}
```

**Then write `DESIGN.md`:** one page covering each token with rationale, the three baseline components, "do's and don'ts" (do use mono for numbers; don't use the accent on more than one element per viewport; do tighten line-height on tables to 1.35).

### Example 2 — brand from zero for a kids' learning app

**Brief:** "Build a system for a kids' coding app for ages 7-12. Should feel safe, energetic, not babyish."

**Decisions:**

1. Direction archetype: Warm Soft (off-white substrate, generous radii).
2. Accent hue: OKLCH(0.72 0.20 35) — warm coral. Hex: `#f08763`. Energetic without being aggressive red. Verify on `#fdf9f3` bg: 3.2:1 — too low for body but fine for buttons (4.5:1 against bg requires darker accent for text use; accent-on-bg for non-text only needs 3:1).
3. Surface ramp: `--bg: #fdf9f3`, `--surface: #ffffff`, `--surface-2: #f7f0e6`.
4. Text ramp: `--fg: #2a1f17` (contrast 13.8:1, AAA), `--muted: #7a6a5d` (contrast 5.1:1, AA).
5. Type stack: display `"Fraunces"` (humanist serif, warm), body `"Inter"` (legible at small sizes), mono `ui-monospace` (for code blocks since this is a coding app).
6. Density: balanced (radius 14px — generous but not babyish, card padding 20px, section padding 80/48px).
7. Semantic: `--good: #2f9148`, `--warn: #e0a330`, `--bad: #c44c2e`.
8. Baseline components — bigger touch targets (44px minimum buttons for tablet use), illustrated empty states, no shadows (kids' apps often go for flat).

**Output `:root`:**

```css
:root {
  --bg: #fdf9f3;
  --surface: #ffffff;
  --surface-2: #f7f0e6;
  --fg: #2a1f17;
  --muted: #7a6a5d;
  --border: #ebe3d8;
  --accent: #f08763;
  --accent-hover: #e07150;
  --accent-fg: #ffffff;
  --good: #2f9148;
  --warn: #e0a330;
  --bad: #c44c2e;
  --radius: 14px;
  --radius-pill: 999px;
  --font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

**DESIGN.md notes:** "Coral over orange because orange reads as urgency/discount; coral reads as warmth. Generous radius and warm bg signal 'safe space.' Fraunces over Comic Sans because Comic Sans reads babyish — Fraunces is humanist, friendly, and grown-up enough that an 11-year-old won't feel patronized."

---

## Anti-patterns

- **Don't pick a hex from memory and call it the brand.** Use OKLCH to verify lightness math. Pretty-looking hexes from your training data often fail contrast.
- **Don't ship two accents.** "Primary purple AND secondary teal" usually means the brief wants two products, or the user is over-specifying. One accent, plus semantic colors (good/warn/bad), is enough for 95% of brands.
- **Don't pick a font you don't have a fallback for.** Every `--font-display` stack ends in a system font. If the web font fails, the page still ships.
- **Don't write component CSS with hardcoded colors.** If the body has `color: #1a1a1a`, that's drift — change it to `var(--fg)` immediately. Every component reads from `:root`.
- **Don't skip the contrast check.** Open the page, look at body text on bg, look at button text on accent. If anything feels thin, it probably fails AA. Use OKLCH-aware contrast checkers, not the old WCAG hex calculators (which under-report for some hues).
- **Don't write DESIGN.md as marketing copy.** It's an operating manual. "Use the accent sparingly" is fine; "Our brand is bold and audacious" is not.
