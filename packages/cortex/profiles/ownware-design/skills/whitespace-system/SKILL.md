---
name: whitespace-system
description: 'The 8px spatial scale, the inside-vs-outside rule, density modes, and vertical rhythm — how much whitespace earns its keep and where to be tight vs loose. Use when sections feel cramped, padding is inconsistent across cards, or when designing density modes (cozy / standard / comfortable / spacious). Pairs with /layout-grids and /web-guidelines. Skip when the brief is "more padding on this card" — one-line edit, not a system.'
trigger: /whitespace-system
---

# Whitespace System — the 8px scale and the rules that make it rhythmic

## Overview

Whitespace isn't decoration. It's the way the eye groups elements: tight space says "these belong together"; wide space says "this is a new idea." Get the scale wrong and every section reads "AI-generated" before the user can articulate why — the diffuse feeling that nothing snaps, nothing aligns, nothing breathes at a steady cadence.

This skill encodes the discipline. One scale (8px multiples) used for every margin, padding, and gap in the artifact. The inside-vs-outside rule that prevents "card with 20px padding inside an 8px gap" wrongness. Four density modes for picking the right tightness per artifact type. Vertical rhythm linked to baseline so heading-to-body and section-to-section breathe at the same meter.

Pair with `/layout-grids` (which sets up the spatial frame) and `/web-guidelines` (which sets the underlying defaults).

---

## Critical Constraints

1. **Snap every value to the 8px scale. Always. No exceptions outside of borders.** Allowed: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 120, 160. Forbidden: `padding: 17px`, `margin: 23px`, `gap: 11px`. If 17px "feels right," use 16px or 20px — your eye is wrong about the 1px.
2. **The inside-vs-outside rule.** A component's internal padding must be ≤ half the gap between components, and a component's internal gap must be ≤ half the section padding around it. Geometric coherence comes from these nested ratios. Break it and the artifact looks "loose."
3. **Pick a density mode and commit.** Cozy, standard, comfortable, spacious — one per artifact. A cozy table inside a spacious page is fine (sub-density inside the outer density); a cozy hero inside a cozy section padding is broken (no breathing room anywhere).
4. **Vertical rhythm ties to a baseline.** Pick a base unit (most often 8px). Section padding = base × {6, 8, 10, 12}. Heading-to-body distance = base × {2, 3}. Block-to-block distance inside a section = base × {3, 4}. The whole page hums at the same meter.
5. **Whitespace is symmetric unless the design says otherwise.** Section padding-top usually equals padding-bottom. Asymmetry (e.g. `padding-top: 96px; padding-bottom: 48px;`) is a deliberate move — the next section starts close, signaling continuation. Use it on purpose, not by accident.
6. **Borders don't snap to the 8 scale.** Borders are 1px, 1.5px, 2px, 4px. Don't try to use the spacing scale on borders — that's how `border: 8px` ends up on a card and reads as a poster.

---

## Framework — the 8px scale

### The single scale, used everywhere

```css
:root {
  --cx-space-0:    0;
  --cx-space-1:   4px;    /* hairline gap, icon inset */
  --cx-space-2:   8px;    /* tight inline gap */
  --cx-space-3:  12px;    /* compact inline */
  --cx-space-4:  16px;    /* standard inline gap */
  --cx-space-5:  20px;    /* card padding (cozy) */
  --cx-space-6:  24px;    /* card padding (standard) */
  --cx-space-7:  32px;    /* grid gap, block separator */
  --cx-space-8:  40px;    /* between subsections */
  --cx-space-9:  48px;    /* section padding (mobile) */
  --cx-space-10: 64px;    /* section padding (tablet) */
  --cx-space-11: 80px;    /* section padding (desktop standard) */
  --cx-space-12: 96px;    /* section padding (desktop generous) */
  --cx-space-13: 120px;   /* section padding (editorial generous) */
  --cx-space-14: 160px;   /* hero padding (oversized) */
}
```

Use the tokens. `padding: var(--cx-space-6)` not `padding: 24px` — same outcome, but the discipline is visible and future edits change one value.

### The inside-vs-outside ratio (the rule under the rule)

```
section padding (outside)
   └─ component gap (between cards)
       └─ component internal padding (inside)
           └─ component internal gap (between elements inside a card)
```

Each level should be at most HALF the level above it. Examples that respect the rule:

| Section pad | Card gap | Card padding | Card inner gap |
|-------------|----------|--------------|----------------|
| 96px        | 48px     | 24px         | 12px           |
| 80px        | 32px     | 16px         | 8px            |
| 64px        | 32px     | 20px         | 8px            |
| 120px       | 64px     | 32px         | 16px           |

**Why this works:** the visual hierarchy (section > component-group > component > element) maps to a geometric hierarchy (96 > 48 > 24 > 12). The eye reads the structure without having to think.

**Examples that break the rule (and feel wrong):**

- Section pad 96px, card padding 32px, card gap 16px → component is bigger than the gap between components. Cards smash together.
- Section pad 48px, card padding 32px → component is 2/3 of section padding. Cards feel oversized for their context.

### Four density modes

Pick one for the artifact. Each is a coherent set of values across roles.

#### Cozy (data-dense, dashboards, admin)

```css
--card-pad:        16px;
--card-inner-gap:  8px;
--grid-gap:        12px;
--section-pad-y:   48px;   /* desktop */
--block-gap:       24px;   /* between blocks inside a section */
--heading-to-body: 12px;
```

Density-leaning. Lots of information packed close. Used in: observability dashboards, admin panels, dense reference tables, terminal-like UIs.

#### Standard (B2B SaaS, product UIs, default)

```css
--card-pad:        24px;
--card-inner-gap:  12px;
--grid-gap:        24px;
--section-pad-y:   80px;
--block-gap:       48px;
--heading-to-body: 16px;
```

The default. Stripe / Linear / Vercel zone. Used in: marketing landings, product pages, B2B SaaS, fintech UIs.

#### Comfortable (consumer, content-heavy, premium)

```css
--card-pad:        32px;
--card-inner-gap:  16px;
--grid-gap:        32px;
--section-pad-y:   96px;
--block-gap:       64px;
--heading-to-body: 24px;
```

More breathing room. Used in: consumer product brands, premium B2B, design tools, content-led marketing.

#### Spacious (editorial, luxury, brand statement)

```css
--card-pad:        48px;
--card-inner-gap:  24px;
--grid-gap:        48px;
--section-pad-y:   120px;
--block-gap:       80px;
--heading-to-body: 32px;
```

Wide-open. The whitespace IS the design. Used in: editorial magazines, luxury brands, Monocle / Apple-tier brand pages, hospitality.

### Vertical rhythm — heading-to-body, block-to-block, section-to-section

Pick a single base unit (usually 8px) and derive everything from it.

```css
:root {
  --baseline: 8px;
}
h1 + p, h2 + p, h3 + p { margin-top: calc(var(--baseline) * 2);  /* 16px — heading→body, standard */ }
p + p                  { margin-top: calc(var(--baseline) * 1.5); /* 12px — paragraph→paragraph */ }
.block + .block        { margin-top: calc(var(--baseline) * 6);   /* 48px — block→block inside section */ }
section + section      { padding-top: calc(var(--baseline) * 10); /* 80px — section→section */ }
```

Multiplying a single baseline makes the entire page hum at one meter. Switch the baseline from 8 to 6, and every spacing scales coherently (would shift everything tighter without breaking the ratios).

---

## Concrete examples

### Example 1 — Card grid with geometric coherence (section / grid / card / element)

Brief: 3-tier pricing section. Standard density.

```css
:root {
  --cx-space-3:  12px;
  --cx-space-6:  24px;
  --cx-space-9:  48px;
  --cx-space-12: 96px;
}

.pricing-section {
  padding: var(--cx-space-12) var(--cx-space-6);  /* 96px vertical, 24px side */
  max-width: 1200px;
  margin-inline: auto;
}

.pricing-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--cx-space-9);                          /* 48px between cards */
}

.pricing-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: var(--cx-space-6);                      /* 24px internal padding */
  display: flex;
  flex-direction: column;
  gap: var(--cx-space-3);                          /* 12px between elements inside */
}
```

Geometric proof: section padding (96) is 2× the grid gap (48), which is 2× the card padding (24), which is 2× the inner gap (12). Each level is exactly half the one above. The eye reads the nesting without thinking — section, then group of cards, then card, then content inside the card.

Break it for comparison: change card padding to 32px and inner gap to 20px. Now the ratios go 96 / 48 / 32 / 20 ≈ 2 / 1.5 / 1.6 — wobbly. The cards feel oversized for the gap; the inner elements feel too far apart for the card. Same content, broken rhythm.

### Example 2 — Dashboard with sub-density (cozy table inside standard sidebar inside comfortable header)

Brief: observability dashboard. The page chrome (header, sidebar) is comfortable. The data table is intentionally dense.

```css
/* outer chrome — comfortable */
.dashboard-header {
  padding: var(--cx-space-9) var(--cx-space-7);  /* 48px / 32px */
  border-bottom: 1px solid var(--border);
}
.dashboard-header h1   { margin-bottom: var(--cx-space-4); }  /* 16px h→body */
.dashboard-header .sub { color: var(--muted); }

/* sidebar nav — standard */
.dashboard-sidebar {
  padding: var(--cx-space-6) var(--cx-space-4);  /* 24px / 16px */
}
.dashboard-sidebar .nav-section + .nav-section {
  margin-top: var(--cx-space-6);                  /* 24px between nav groups */
}
.dashboard-sidebar .nav-item {
  padding: var(--cx-space-2) var(--cx-space-3);   /* 8px / 12px — nav items are tight */
  border-radius: 6px;
}

/* data table — cozy (intentional sub-density) */
.data-table th, .data-table td {
  padding: var(--cx-space-2) var(--cx-space-3);   /* 8px / 12px */
  font-size: 14px;
  line-height: 1.35;
}
.data-table tr + tr td { border-top: 1px solid var(--border); }
```

Why it works: each region has a coherent density of its own. The header breathes (comfortable). The sidebar is workmanlike (standard). The table is dense (cozy) — but the table's INTERNAL coherence still respects the inside-vs-outside rule: 12px cell padding is half of 24px section padding around it. Sub-density is allowed when it's deliberate AND when the sub-region's internal ratios still hum.

---

## Anti-patterns

- **`padding: 17px` because "20 looks too loose."** Stop. Either 16 or 20 — pick. The 3px difference between them is a real design choice; the 1px nudge is your eye over-tuning.
- **Mixing scales — some `padding: 16px`, some `padding: 15px`, some `padding: 18px`.** Stop. The scale is one thing. Hoist every spacing into the token block and reference. Drift creeps in over edits; tokens prevent it.
- **Card padding > component gap.** Stop. Cards with 32px padding in a 16px-gap grid look smashed together — the cards are denser internally than they are external to each other. Break the inside-vs-outside rule and the eye loses the grouping.
- **Section padding = block padding = element padding.** Stop. If section padding (96px) equals block-to-block spacing (96px) equals heading-to-body (96px), the page has no hierarchy. The eye can't tell where one block ends and the next begins. Each level needs its own value.
- **All four densities in one artifact.** Stop. A spacious hero, cozy features, comfortable testimonials, standard CTA — that's not range, it's chaos. Pick one density; sub-density inside a region (like the table in Example 2) is the exception, not the rule.
- **`gap: 8px` on a section's outer container.** Stop. Sections breathe with 48-120px. An 8px gap between two sections looks like a layout bug. Use the right scale step for the role.
- **Asymmetric top/bottom padding by accident.** Stop. `padding: 96px 0 48px;` reads "this section is closer to the next than the previous." If that's intentional (signaling continuation), great — say so. If you typed it without thinking, fix it.
- **`margin` instead of `gap` inside a flex/grid container.** Stop. `margin` compounds (the last-child margin doesn't collapse, the first-child margin escapes the container). `gap` is one declaration on the parent — predictable and rhythmic.
