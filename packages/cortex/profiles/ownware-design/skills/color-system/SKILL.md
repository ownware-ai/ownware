---
name: color-system
description: 'Generate a defensible color palette using OKLCH math — accent + ramp + neutrals + semantics — and verify contrast hits WCAG before shipping. Use when picking an accent for a new brand, when an existing accent fails contrast, or when the user wants tint/shade variants. Do NOT use for "just pick a color" tweaks — the surgical edit is faster. Pairs with design-system-builder (which calls into this for accent generation).'
trigger: /color-system
---

# Color System — OKLCH math, not vibes

## Overview

Most accent picking starts and ends in RGB hex, which is why most accents fail contrast: RGB hides lightness. OKLCH (L for lightness 0-1, C for chroma 0-0.4, H for hue 0-360) separates the three properties so two colors with the same L look equally bright to the eye, regardless of hue.

This skill produces three artifacts: (1) an accent hue chosen and verified, (2) a five-stop ramp for hover/pressed/focus tints, (3) a neutrals + semantics set that doesn't fight the accent. Every color ships with a contrast measurement.

Use this when building a system from zero, fixing a failed contrast check, or extending a system into dark mode. Don't use this when the user said "change accent to Linear purple" — that's a one-token swap, not a system.

---

## Critical Constraints

1. **OKLCH first, hex second.** Pick L, C, H. Convert to hex only after the math works. Browsers support `oklch()` in CSS directly — the token can ship as `oklch(0.65 0.18 280)` or as the hex equivalent.
2. **Contrast ratios are non-negotiable.**
   - `--fg` on `--bg`: ≥ 7:1 (AAA body text).
   - `--muted` on `--bg`: ≥ 4.5:1 (AA body).
   - `--accent-fg` on `--accent`: ≥ 4.5:1 (AA non-display button text).
   - `--accent` on `--bg`: ≥ 3:1 (AA UI components).
   - `--bad` / `--good` / `--warn` on `--bg`: ≥ 4.5:1 each.
3. **One accent at the system level.** Multiple accents fragment hierarchy. Use the accent ramp for tints; use semantics (`--good`, `--warn`, `--bad`) for state.
4. **Semantics are not free hues.** Good ≈ green (H 120-150), warn ≈ amber (H 50-80), bad ≈ red (H 5-25). Pick saturations that are calmer than the accent — saturated semantics steal the eye from the accent.
5. **Light and dark mode are different palettes, not inverted ones.** Dark mode is NOT light mode with L flipped. Surfaces get tighter L spread; muted gets higher L (lighter) than expected; accents often shift +0.08 L to stay readable.
6. **Don't trust the WCAG calculator alone for OKLCH colors.** Use OKLCH-native APCA-aware tools where possible. The legacy WCAG ratio underreports for some hues (notably yellows and greens).

---

## Framework — the five steps

Resolve in this order. Each step depends on the previous.

### Step 1 — Pick the accent hue

The hue is the brand. Hue choice flows from the brief's mood:

| Brand feel | Hue range (H) | Typical hex anchors |
|------------|---------------|---------------------|
| Trust / B2B / tech | 220-260 (cool blue to indigo) | `#3b82f6`, `#5e6ad2`, `#635bff` |
| Energy / creative | 280-320 (purple to magenta) or 0-15 (red) | `#a855f7`, `#ec4899`, `#dc2626` |
| Warmth / consumer | 20-50 (orange to amber) | `#f97316`, `#eab308` |
| Growth / health | 120-160 (green) | `#10b981`, `#16a34a` |
| Premium / restrained | use near-neutral; L 0.20 (dark) or 0.95 (light) with C 0.02-0.05 | `#1a1a1a` on light, `#f5f5f5` on dark |
| Editorial / luxury | very low chroma (0.04-0.08) on classic hues 200-280 | `#374151`, `#1e293b` |

### Step 2 — Pick L and C for the accent

For light-mode systems (`--bg` at L ≈ 0.97):
- Accent L: 0.55-0.62 (mid-bright, readable on light bg).
- Accent C: 0.14-0.22 (B2B), 0.20-0.28 (consumer).

For dark-mode systems (`--bg` at L ≈ 0.10):
- Accent L: 0.68-0.78 (lifted, readable on dark bg).
- Accent C: 0.12-0.18 (darker bg requires lower C to avoid neon).

### Step 3 — Generate the accent ramp

Same H, same C, five values of L:

| Stop | L | Use case |
|------|---|----------|
| `--accent-50` (or `--accent-soft-bg`) | 0.92-0.95 | very light tint, table row stripe, badge bg |
| `--accent-100` | 0.82-0.88 | hover bg for ghost button |
| `--accent` | the chosen value (0.55-0.65 light mode, 0.65-0.75 dark mode) | the brand |
| `--accent-hover` | accent ± 0.05 (darker for light mode, lighter for dark mode) | button hover |
| `--accent-pressed` | accent ± 0.10 | button active state |

Light mode hover is darker; dark mode hover is lighter. Don't get this backwards.

### Step 4 — Build the neutrals

Neutrals are NOT grey-only. Tint them with the accent hue at C ≈ 0.005-0.015 so they read as belonging to the family.

Light mode:
```
--bg:        L 0.98, C 0.005, H = accent hue  → ≈ #fafafa
--surface:   L 1.00, C 0,     H = 0           → #ffffff
--surface-2: L 0.96, C 0.008, H = accent hue  → ≈ #f3f3f5
--fg:        L 0.15, C 0.01,  H = accent hue  → ≈ #1a1a1d
--muted:     L 0.45, C 0.01,  H = accent hue  → ≈ #6b6b71
--border:    L 0.88, C 0.005, H = accent hue  → ≈ #e0e0e3
```

Dark mode:
```
--bg:        L 0.08, C 0.005, H = accent hue  → ≈ #0d0d0f
--surface:   L 0.12, C 0.008, H = accent hue  → ≈ #16161a
--surface-2: L 0.16, C 0.010, H = accent hue  → ≈ #1f1f25
--fg:        L 0.92, C 0.005, H = accent hue  → ≈ #e8e8eb
--muted:     L 0.62, C 0.010, H = accent hue  → ≈ #94949c
--border:    L 0.22, C 0.012, H = accent hue  → ≈ #2e2e36
```

### Step 5 — Pick the semantics

Three semantics. Each at a chroma LOWER than the accent (so they don't fight it). Match L to the accent so they read at the same emphasis.

| Token | Hue range | Light mode anchor | Dark mode anchor |
|-------|-----------|-------------------|-------------------|
| `--good` | 140-160 (green) | `#16a34a` (OKLCH 0.62 0.16 145) | `#3fb950` (OKLCH 0.72 0.17 145) |
| `--warn` | 60-85 (amber) | `#d97706` (OKLCH 0.65 0.16 65) | `#d29922` (OKLCH 0.74 0.14 75) |
| `--bad`  | 10-25 (red) | `#dc2626` (OKLCH 0.58 0.21 25) | `#f85149` (OKLCH 0.66 0.20 25) |

Semantics never carry meaning alone (Principle 21 + accessibility). Always pair with an icon or label.

---

## Concrete examples

### Example 1 — accent generation for a fintech B2B brand

**Brief:** "Trust feel, B2B, light mode. Existing brand color is `#2563eb` but the body text feels thin."

**Audit existing color:**
- `#2563eb` in OKLCH is approximately 0.55 0.21 263.
- On `--bg: #fafafa` (L 0.98), contrast is 4.6:1. Passes AA non-text but fails AAA.
- Used for body text it would fail, which matches the "thin" feeling — too saturated, not enough L difference.

**Decision: keep hue, adjust L.**

Pick: OKLCH(0.50 0.18 263) → hex ≈ `#1d4ed8`.
- Contrast on `#fafafa`: 7.4:1 — passes AAA for text use.
- Slightly darker, slightly less saturated.

**Generate ramp:**

```css
--accent-soft:    oklch(0.93 0.04 263);  /* ≈ #e0e7fb */
--accent-100:     oklch(0.85 0.08 263);  /* ≈ #b8c8f4 */
--accent:         oklch(0.50 0.18 263);  /* ≈ #1d4ed8 */
--accent-hover:   oklch(0.45 0.18 263);  /* ≈ #1842b8 */
--accent-pressed: oklch(0.40 0.17 263);  /* ≈ #143699 */
--accent-fg:      #ffffff;               /* contrast on accent: 7.1:1 */
```

**Neutrals (hue-tinted, family-coherent):**

```css
--bg: oklch(0.98 0.005 263);   /* ≈ #fafafb */
--surface: #ffffff;
--surface-2: oklch(0.96 0.008 263);  /* ≈ #f3f4f7 */
--fg: oklch(0.15 0.01 263);    /* ≈ #1a1b1f */
--muted: oklch(0.45 0.01 263); /* ≈ #6b6c72 — contrast 5.3:1 on bg */
--border: oklch(0.88 0.008 263); /* ≈ #dedfe5 */
```

**Verification (contrast):**
- `--fg` on `--bg`: 14.2:1 (AAA, easily).
- `--muted` on `--bg`: 5.3:1 (AA passes; close to AAA at 7:1 — fine for secondary copy).
- `--accent` on `--bg`: 7.4:1 (AAA for text, passes AA UI 3:1 trivially).
- `--accent-fg` (#fff) on `--accent`: 7.1:1 (AAA — confident for button text).

Ship.

### Example 2 — dark-mode palette for a developer dashboard

**Brief:** "Dense observability dashboard. Dark mode. Teal accent. Lots of tabular data."

**Decisions:**
- Hue: 195 (teal — leans developer rather than corporate blue).
- Accent: OKLCH(0.72 0.13 195) → ≈ `#52b7c4`. Lower chroma so it doesn't neon against the dark bg. Lifted L so it reads on `--bg`.

**Generate:**

```css
:root {
  /* surfaces — tight L spread, accent hue tint */
  --bg:        oklch(0.08 0.005 195);  /* ≈ #0b0e10 */
  --surface:   oklch(0.12 0.008 195);  /* ≈ #13181b */
  --surface-2: oklch(0.16 0.010 195);  /* ≈ #1c2226 */

  /* text — high L, slight hue tint to feel cohesive */
  --fg:    oklch(0.92 0.005 195);  /* ≈ #e8edee — contrast 14.5:1 on bg */
  --muted: oklch(0.62 0.010 195);  /* ≈ #93a1a4 — contrast 5.7:1 on bg */

  --border: oklch(0.22 0.012 195); /* ≈ #2d363a */

  /* accent ramp */
  --accent-soft:    oklch(0.20 0.05 195);  /* ≈ #1d3036 — soft bg tint */
  --accent:         oklch(0.72 0.13 195);  /* ≈ #52b7c4 — contrast 6.8:1 on bg */
  --accent-hover:   oklch(0.78 0.13 195);  /* ≈ #6cc8d4 (lighter for dark mode!) */
  --accent-pressed: oklch(0.84 0.12 195);  /* ≈ #88d8e2 */
  --accent-fg:      oklch(0.10 0.01 195);  /* dark text on the bright accent — contrast 11.4:1 */

  /* semantics — lower chroma than accent, matched L */
  --good: oklch(0.72 0.17 145);  /* ≈ #4abf7c */
  --warn: oklch(0.74 0.14 75);   /* ≈ #d6a043 */
  --bad:  oklch(0.66 0.20 25);   /* ≈ #f06e6e */
}
```

**Verification:**
- `--fg` on `--bg`: 14.5:1 (AAA).
- `--muted` on `--bg`: 5.7:1 (AA, almost AAA — fine for secondary).
- `--accent` on `--bg`: 6.8:1 — passes AAA for text. Confident for accent-colored labels.
- `--accent-fg` (dark) on `--accent` (light teal): 11.4:1 — buttons read crisp.
- Semantics: each ≥ 4.5:1 against bg.

Notice the inversion: `--accent-hover` is LIGHTER than `--accent`. That's the dark-mode rule.

---

## Anti-patterns

- **Don't pick the accent in hex and call it done.** Hex tells you nothing about L or C. A pretty `#7c3aed` purple might be L 0.50 (low contrast on light bg) or L 0.65 (fine) — you can't tell from the hex alone.
- **Don't ship `--muted` at L 0.50 on light backgrounds.** That's the magic line where it slips below 4.5:1 contrast on most bg values. Aim for L 0.42-0.46.
- **Don't invert L for dark mode.** Light mode `--bg: 0.98` and `--fg: 0.15` does NOT become dark mode `--bg: 0.02` and `--fg: 0.85`. That gives you a pitch-black bg that fights every shadow and a too-bright fg that vibrates. Use L 0.08 and 0.92 — the spread is asymmetric on purpose.
- **Don't ship a semantic at the same chroma as the accent.** A 0.20-chroma green next to a 0.20-chroma blue accent makes the page look like a traffic light. Drop semantics by 0.04-0.06 C below the accent.
- **Don't rely on color alone for state.** Pair every semantic color with an icon or label. Red text without a "!" icon fails on red-green colorblind users (8% of men).
- **Don't generate the ramp by tweaking hex by hand.** Same hue, same chroma, varying L. Hex tweaking introduces hue drift you won't see until two stops are next to each other.
