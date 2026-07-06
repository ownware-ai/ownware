---
name: icon-system
description: 'Pick + size + pair an icon library — library shortlist, stroke-weight matched to body type, size scale tied to typography, filled-vs-outlined semantic rules, anti-cliché pairings. Use when the artifact needs more than three icons, when an icon set "feels wrong" (mixed weights, mismatched sizes, ambiguous metaphors), or when adopting a new library for a system. Skip for single-icon situations — just pick one from Lucide at 16px and move on. Pairs with /typography-system.'
trigger: /icon-system
---

# Icon System — pick once, size with type, pair semantically

## Overview

Icons are typography for objects. They have weight, size, and meaning — and they live or die by consistency. The most common artifact failure isn't "the wrong icon," it's "five icons from three libraries at four sizes with three stroke widths" — a system that reads as chaos before any single glyph is even examined.

This skill answers four questions in order: (1) which library, (2) what stroke weight, (3) what sizes, (4) when filled vs outlined. Get all four right and the icons disappear into the system; get any wrong and they shout.

---

## Critical Constraints — read these first

1. **One library per artifact.** Never mix Lucide + Heroicons + Phosphor. Each library has its own grid, its own metaphor language, its own optical balance. Mixing them is the icon equivalent of three fonts in one paragraph.
2. **Stroke weight matches the body text weight.** Body type weight 400 → 1.5px stroke. Body weight 500 → 2px stroke. Body weight 600 → 2.25px stroke. A 1px outlined icon next to a 500-weight body looks anemic; a 2.5px icon next to 400-weight body looks heavy.
3. **Icon size is tied to type size, not picked freely.** 16px icon for 14-16px body. 20px for 18-20px lead text. 24px for navigation and section headings. The "20px next to 14px body" trap (an oversized hint next to a small label) is the most common slop.
4. **Outlined for navigation and utility; filled ONLY for active/selected state.** Filled-everywhere icons read as toy/consumer; outlined-everywhere reads as cold/admin. Use outlined as default; flip to filled as the selected indicator in tabs, nav rails, toggles.
5. **Every icon needs a semantic role, not a vibe.** `chevron-down` for "expand this". `ellipsis` (three dots) for "more actions". `arrow-right` for "navigate to next". Using `chevron-down` for "more actions" makes users hunt. Pick the canonical metaphor and stick to it.
6. **Icon + label, not icon alone, for any action a stranger might misread.** Icon-only buttons are fine for universal metaphors (search, settings, close). Anything domain-specific (e.g. "publish", "archive", "fork") gets a visible label or at minimum a tooltip + aria-label.

---

## Framework

### Step 1 — Library picker

Pick once. Pin the version. Don't mix.

| Library | Stroke style | Best for | Avoid when |
|---------|--------------|----------|------------|
| **Lucide** | 2px outlined, geometric, neutral | Default B2B SaaS, dashboards, developer tools. The Ownware default. | You need filled-style brand iconography. Lucide is outlined-first; filled variants are sparse. |
| **Phosphor** | 6 weights (thin/light/regular/bold/fill/duotone) per glyph | Consumer apps, brand-led design where you need filled + outlined of the same glyph for state toggling. Best variety. | The brief calls for ultra-restrained tech (Phosphor's range can feel too playful). |
| **Heroicons** | 24px outlined + 20px solid, Tailwind-native | If the project already uses Tailwind UI patterns. Tight, restrained, opinionated. | You need anything beyond the ~300 included glyphs — coverage is the narrowest of the four. |
| **Tabler** | 1.5px outlined, large set (3000+), modern | Dense admin UIs, internal tools, dashboards needing obscure glyphs (database, server, custom domain). | The artifact is marketing-facing — Tabler's slight thinness reads as "internal tool" on landing pages. |
| **Material Symbols** | 3 styles × 4 weights × 3 grades = wide range | Android-paired products, Material-aligned brand. | Anything trying to look NOT-Google. The Material identity is strong. |

Default for Ownware artifacts: **Lucide at 2px stroke**, unless the brand explicitly calls for one of the others.

### Step 2 — Stroke weight rule

Match the icon stroke to the body type weight. This is the rule that makes icons "vanish" into the type system.

| Body type weight | Icon stroke weight | Library setting |
|------------------|---------------------|------------------|
| 300 (light) | 1px | Phosphor `thin` or Tabler 1px override |
| 400 (regular) | 1.5px | Tabler default, Phosphor `light` |
| 500 (medium) | 2px | Lucide default, Phosphor `regular` |
| 600 (semibold) | 2.25px | Phosphor `bold` |
| 700 (bold) | 2.5px | Phosphor `bold` with custom stroke |

For SVG icons, set stroke via CSS so it inherits from the system:

```css
.icon {
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  width: 1em;
  height: 1em;
  flex-shrink: 0;
}
```

`width/height: 1em` is the trick — the icon scales with the surrounding font-size, so a 16px label automatically gets a 16px icon.

### Step 3 — Size scale tied to typography

| Context | Type size | Icon size | Why |
|---------|-----------|-----------|-----|
| Inline in body copy | 16px | 16px | Match cap-height. Larger reads as "look at me" mid-sentence. |
| Form inputs, button labels | 14-16px | 16px | Standard. |
| Navigation rail, sidebar | 14px label below | 24px | Icon carries the weight; label is secondary identifier. |
| Section headings (h3, h4) | 18-20px | 20px | Match heading optical size. |
| Tabs, segmented controls | 14px | 16px (outlined) → 16px (filled when active) | Same SIZE, different STYLE for state. |
| Empty-state illustration | n/a | 40-48px | Visual moment; lift the icon out of the type system entirely. |
| KPI tile metric eyebrow | 12-13px caps | 14-16px | Slightly larger than the eyebrow text. |

The trap: 20px icons next to 14px body text. That's a 1.43x ratio that reads as "icon shouting at label." Either match the size, or jump to 24px+ for a deliberate hierarchy break (nav rail).

### Step 4 — Filled vs outlined semantic rules

| Use | Style |
|-----|-------|
| Navigation rail, default state | Outlined |
| Navigation rail, selected/active state | Filled (same glyph) |
| Toolbar utility (search, settings, share) | Outlined |
| Toggle button, ON state | Filled |
| Toggle button, OFF state | Outlined |
| Tab indicator, active | Filled |
| Decorative (empty states, illustrations) | Either, pick one and stick with it |
| Status badge ("done", "warning") | Filled (carries semantic color) |
| Brand mark, logo lockup | Filled (logo concerns, not icon concerns) |

The discipline: outlined is the resting state of the system. Filled is the language of "this is selected / this is active / this is on". Mixing filled icons throughout a navigation rail (rather than reserving fill for the selected one) destroys the selected-state signal.

### Step 5 — Semantic metaphor discipline

Pick one icon per concept. Use it consistently across the artifact.

| Concept | Use | Don't use |
|---------|-----|-----------|
| Expand a collapsed section | `chevron-down` | `plus`, `arrow-down`, `more-vertical` |
| More actions on this item | `ellipsis-vertical` (three dots) or `ellipsis-horizontal` | `chevron-down`, `settings`, `plus` |
| Navigate to next page/screen | `arrow-right` | `chevron-right` (chevron is for collapse, not navigation) |
| Drill into a list item | `chevron-right` | `arrow-right` (arrow implies "go to a separate place") |
| Delete / destroy | `trash-2` (with confirmation) | `x` (x is dismiss, not delete) |
| Dismiss a modal / close | `x` | `trash-2` |
| Edit in place | `pencil` or `pen` | `edit-3` mixed with `pencil` in same artifact |
| External link (opens new tab) | `arrow-up-right` or `external-link` | bare `arrow-right` (implies internal nav) |
| Sort | `arrows-up-down` | `chevron-up-down` (use chevron-up-down for select dropdowns) |
| Loading | `loader-2` (spinning) or skeleton, never the icon-with-dots pattern | static spinners |

When unsure: pick the literal metaphor (trash for delete, magnifying glass for search) over the clever one. Clever icons make users hunt.

---

## Concrete examples

### Example 1 — Navigation rail with 6 outlined icons + filled selected state

A left rail with: Inbox, Today, Upcoming, Projects, Tags, Settings. Inbox is selected.

```html
<nav class="rail" data-cx-id="nav-rail">
  <a class="rail-item is-active" href="/inbox" aria-current="page">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <!-- inbox: FILLED variant when active -->
      <path fill="currentColor" d="M22 12h-6l-2 3h-4l-2-3H2v8a2 2 0 002 2h16a2 2 0 002-2v-8zM5.45 5.11L2 12v5h6l2 3h4l2-3h6v-5l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
    </svg>
    <span class="rail-label">Inbox</span>
  </a>
  <a class="rail-item" href="/today">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <!-- calendar: OUTLINED 2px stroke -->
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2"/>
      <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2"/>
      <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/>
    </svg>
    <span class="rail-label">Today</span>
  </a>
  <!-- Upcoming, Projects, Tags, Settings — all OUTLINED at 24px, label 12px below -->
</nav>

<style>
.rail { display: flex; flex-direction: column; gap: 4px; padding: 16px 8px; width: 80px; }
.rail-item {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 12px 8px;
  border-radius: 8px;
  color: var(--cx-muted);
  text-decoration: none;
  transition: color 120ms ease-out, background 120ms ease-out;
}
.rail-item:hover {
  color: var(--cx-fg);
  background: var(--cx-sunken);
}
.rail-item.is-active {
  color: var(--cx-accent);
  background: color-mix(in oklch, var(--cx-accent) 8%, transparent);
}
.rail-item .icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}
.rail-label {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
}
</style>
```

What this gets right:
- One library (Lucide-shaped paths).
- One stroke weight (2px) across all outlined icons.
- One size (24px) for nav-rail icons; label is 12px.
- Filled variant ONLY on the active item — fill is the selected-state signal.
- Same metaphor system throughout (no chevron-where-arrow-should-be).

### Example 2 — Inline icons in body text and a primary CTA

```html
<p>Ownware ships <svg class="icon-inline"><!-- lucide check --></svg> end-to-end encrypted, with <svg class="icon-inline"><!-- lucide zap --></svg> sub-second sync.</p>

<button class="btn-primary">
  <svg class="icon"><!-- lucide arrow-right --></svg>
  <span>Start free trial</span>
</button>

<style>
.icon-inline {
  width: 1em;
  height: 1em;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  vertical-align: -0.15em;  /* nudge to baseline */
  margin: 0 0.15em;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  background: var(--cx-violet);
  color: var(--cx-accent-fg);
  font-weight: 500;
  border-radius: 8px;
}
.btn-primary .icon {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
}
.btn-primary span { font-size: 14px; }
</style>
```

The `1em` trick on `.icon-inline` ties the icon to whatever font-size it inherits. 14px body → 14px icon. 18px lead → 18px icon. No manual sizing per context.

The button: 14px text label, 16px icon, 8px gap. Icon sits right (`arrow-right` means "go" — placement reinforces metaphor). Stroke 2px matches the 500-weight button text.

---

## Anti-patterns

- **Mixing two icon libraries.** A Lucide pencil next to a Heroicons trash next to a Phosphor settings reads as three vendors. Pick one. Pin its version. Done.
- **Mixing stroke widths in one artifact.** A 2px-stroke outlined arrow next to a 1px-stroke outlined chevron. The eye reads "two systems" before reading "two icons."
- **20px icons next to 14px body text.** The icon shouts. Either size them to match (16px), or jump to a deliberate hierarchy break (24px nav, 12px caption beneath).
- **Filled icons everywhere.** Reads as Material Design knockoff or toy consumer app. Use outlined as default; reserve filled for selected/active state.
- **Outlined icons EVERYWHERE including the selected nav item.** Now the user has no idea which item is selected. Filled-when-active is the cheapest, clearest signal.
- **`chevron-down` for "more actions".** Users interpret chevron as "expand to see more of THIS". Three dots (`ellipsis-vertical`) is the canonical "more actions" metaphor.
- **`arrow-right` for "drill into list item".** Arrow implies "navigate to a different place". Chevron-right is the affordance for "open this row in place / show its detail". Get this wrong and users misread every list.
- **Icon-only buttons for domain-specific actions.** A `git-fork` icon alone is fine for engineers; a `git-fork` icon alone for a marketing manager is gibberish. Add a visible label, or at minimum tooltip + `aria-label`.
- **`stroke-width: 1.5` hard-coded on the SVG.** Set it via CSS so the system can tune all icons in one place. Inline `stroke-width` defeats the token system.
