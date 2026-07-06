---
name: taste-system
description: 'Anti-slop discipline for first drafts. Three tunable dials — variance, motion, density — that turn generic AI output into something with a point of view. Use AFTER tokens are picked but BEFORE the first artifact is written, OR when a critique reveals the result looks generic. Do NOT use as a substitute for `critique` — taste sets intent; critique audits the result.'
trigger: /taste-system
---

# Taste System — three dials against the generic

## Overview

Default AI output is generic. Same Bento grid. Same gradient hero. Same three feature cards with little icons. Same `<button>` with `rounded-lg shadow`. The brand could be a CRM, a meditation app, or a CAD tool — you can't tell from the page.

Taste fixes that by forcing three deliberate choices BEFORE the artifact is written: how much visual variance is this page allowed (variance dial), how much motion does it use (motion dial), and how packed is the screen (density dial). Each dial has three settings; nine combinations cover the design space.

Use this between `discovery` and `artifact` — after the direction is picked but before any HTML is written. Use it again if `critique` says "this feels generic" — the fix is usually one dial in the wrong setting.

---

## Critical Constraints

1. **Pick a setting on every dial. Don't skip any.** "Default everything to balanced" is the slop default; that's the trap this skill exists to escape.
2. **Dials are intentional, not stacked.** Variance HIGH + Motion HIGH + Density HIGH = chaos. Pick at most ONE dial at HIGH. Two HIGH dials needs explicit justification.
3. **Match the dials to the audience, not the founder's preference.** Solo founders love HIGH variance; their B2B buyers want LOW. If the brief and the buyer disagree, the buyer wins.
4. **Write the dial settings to the top of the artifact as an HTML comment.** Future agents (and you, three turns later) need to know why a section breaks the grid. Make the intent visible.
5. **Every "rule break" needs a reason in the comment.** "Breaks the 12-col grid intentionally — variance HIGH, hero earns a wide block." Without the comment, the next agent regularises it and the page goes back to generic.

---

## The three dials

### Dial 1 — Variance (LOW / MEDIUM / HIGH)

How much the layout deviates from a uniform grid.

**LOW (uniform, B2B safe):**
- Every section has the same gutters, same padding, same column count.
- Cards are all the same size. Images are all the same aspect ratio.
- Headlines are the same size on every section. Subheads the same.
- The page reads as a clean catalog — Stripe pricing, Linear product, Vercel docs.
- **Use for:** B2B, enterprise, fintech, anything where credibility > expression.

**MEDIUM (rhythm with one signature move):**
- The default grid holds for 80% of the page. ONE section breaks it on purpose — usually the hero or a "manifesto" pull section.
- One element is oversized (a single hero photograph at 2× the next-largest, or one feature card spanning two columns).
- **Use for:** mid-market SaaS, consumer apps with brand ambition, agency landing pages.

**HIGH (asymmetric, expressive):**
- The grid is a starting point, not a rule. Sections vary in gutter, padding, alignment.
- Asymmetric layouts (left-aligned hero with photo right; right-aligned section with quote left).
- Type-led pages with oversized display (headlines 80-160px on desktop), text-wrap manipulated.
- Multiple "signature moves" per page: oversized number, rotated label, off-grid card.
- **Use for:** creative agencies, fashion drops, art-led brands, music, opinionated indie products.

### Dial 2 — Motion (NONE / SUBTLE / EXPRESSIVE)

How animations work on the page.

**NONE:**
- No transitions, no hover transforms, no scroll triggers.
- Color-only hover (`background` swap on buttons). Cursor change on interactive. Nothing else.
- Justified when: the audience values precision (developer tools, dashboards, anything ops-facing), when accessibility is a stated priority, when `prefers-reduced-motion` is the assumed default.

**SUBTLE (the default):**
- Button hovers transition 120-180ms on background + border.
- Cards lift 1-2px on hover with a subtle shadow change.
- Page section reveals on scroll: 200ms opacity + 8-12px translate-Y, fired once, not on every re-scroll.
- Focus rings animate in 100ms.
- **Easing:** `cubic-bezier(0.4, 0, 0.2, 1)` (ease-out) for enter, `cubic-bezier(0.4, 0, 1, 1)` (ease-in) for exit. Enter 200ms, exit 140ms.

**EXPRESSIVE:**
- Hero has a real moment: animated headline reveal, color shift on the bg, an animated SVG, a typing effect, parallax on a key image.
- Sticky elements as you scroll (sidebar that animates in, table-of-contents that highlights the current section).
- Hover states change more than color (scale 1.02, rotation 1-2deg, image zoom).
- All motion still respects `@media (prefers-reduced-motion: reduce) { * { animation: none; transition: none; } }`.

### Dial 3 — Density (SPACIOUS / BALANCED / DENSE)

How much real estate each element gets.

**SPACIOUS:**
- Section padding 120-160px vertical desktop / 64-80px mobile.
- Card padding 32-48px.
- Single-column body width ≤ 64ch (≈ 640px).
- Headlines have a lot of whitespace around them. Body type is 17-19px.
- **Use for:** editorial brands, premium SaaS, anything where "considered" is the read.

**BALANCED:**
- Section padding 64-96px desktop / 48-56px mobile.
- Card padding 20-28px.
- Body width up to 75ch.
- Body type 15-16px. Headlines breathe but don't drown.
- **Use for:** most B2B SaaS, consumer apps, anything default. This is the safe choice.

**DENSE:**
- Section padding 32-48px desktop / 24-32px mobile.
- Card padding 12-16px.
- Body type 13-14px. Line-height 1.45 on body, 1.35 on tables.
- Multi-column where possible. Sidebars stay open. Tables show 10+ rows above the fold.
- **Use for:** dashboards, admin tools, developer reference docs, anything where "I came here to look something up" is the user job.

---

## The nine combinations — what each says

| Variance | Motion | Density | Reads as |
|----------|--------|---------|----------|
| LOW | NONE | DENSE | Bloomberg terminal. Pure utility. Power user. |
| LOW | SUBTLE | BALANCED | Stripe / Linear / Vercel. The B2B-credibility default. |
| LOW | SUBTLE | SPACIOUS | Apple landing. Premium tech credibility. |
| MEDIUM | SUBTLE | BALANCED | Modern SaaS landing — Notion, Coda, Pitch. The most-shipped configuration. |
| MEDIUM | EXPRESSIVE | SPACIOUS | Premium consumer — Headspace, Calm, Patreon. Brand-led. |
| HIGH | NONE | SPACIOUS | Editorial / magazine. The Cereal, Monocle, Kinfolk zone. |
| HIGH | SUBTLE | BALANCED | Agency landing or creative tool — Cosmos, Are.na. |
| HIGH | EXPRESSIVE | DENSE | Experimental / brutalist. Almost always wrong for SaaS; right for art / music / fashion drops. |
| LOW | EXPRESSIVE | SPACIOUS | Hospitality / restaurants / luxury — Aman, Stripe Sessions. Motion as elegance, not energy. |

If your dial choices are not in this table, you're combining settings that don't reinforce each other. Re-pick.

---

## How to write taste into the artifact

When you've picked your settings, the FIRST line inside `<body>` is an HTML comment naming them:

```html
<body>
  <!-- Taste: variance MEDIUM, motion SUBTLE, density BALANCED. Signature move: oversized hero number (-tracking, 96px display).  -->
  <header data-cx-id="topnav">…</header>
  …
```

Then write the page consistent with that comment. If you later break the grid, add a region-level comment naming the variance break:

```html
<!-- Variance break: this section uses a 7+5 asymmetric split because the hero quote earns weight. -->
<section data-cx-id="manifesto">…</section>
```

The comment is for the next agent. Without it, regression to generic happens within two edits.

---

## Concrete examples

### Example 1 — solo founder dev tool landing page

**Brief:** "Landing page for my dev tool. Audience: technical, solo founders + small teams. Should feel premium but not corporate. Direction: modern-minimal with Linear-style purple."

**Dial choices:**
- Variance: MEDIUM. The hero earns a signature move; the rest of the page stays uniform.
- Motion: SUBTLE. This audience hates marketing motion. Hovers shift color in 140ms; one scroll-reveal on the hero. That's it.
- Density: BALANCED. Body at 15px, section padding 80px desktop. Not editorial-airy; not dashboard-dense.

**Signature move:** the hero opens with a single oversized command pair — `$ npm install x-tool` rendered at 32px in `--font-mono`, sitting alone in the upper-third of the viewport. No hero photo. No three-CTA bar.

**Artifact comment:**

```html
<body>
  <!-- Taste: variance MEDIUM, motion SUBTLE, density BALANCED. Signature: oversized mono install command as the visual anchor. Audience values speed-to-comprehension; refuse marketing motion. -->
```

**Implementation rules:**
- Hero h1: 56px desktop, mono `--font-mono`, color `--fg`. The install command IS the headline. Subhead is the one-sentence value prop.
- Feature cards: identical sizing, three across desktop, one column mobile. Hover: `border-color: var(--accent)` in 140ms. No scale, no shadow.
- Pricing cards: same height, same width, ≤ 3. The middle one has a `--accent` border, not a different bg.
- One scroll-reveal: the hero command, 200ms opacity from 0 to 1 + 12px translate-Y. Nothing else animates.
- `@media (prefers-reduced-motion: reduce)` removes the scroll reveal entirely.

### Example 2 — consumer meditation app landing

**Brief:** "Landing page for a meditation app. Audience: stressed knowledge workers, 25-40. Direction: warm-soft with terracotta accent."

**Dial choices:**
- Variance: HIGH. Brand-led product, expression > grid. Hero is a single sentence + a generous photograph that bleeds past the gutter; features are an asymmetric "story" layout rather than a card row.
- Motion: EXPRESSIVE. Slow, soft transitions match the brand voice. Hero photograph has a 4-second ken-burns effect (1.05× scale over 4s, infinite ease-in-out alternate). Scroll reveals at 400ms duration with elastic easing.
- Density: SPACIOUS. Section padding 160px desktop. Body at 18px. Single-column body ≤ 60ch.

**Signature move:** the hero is a single statement set in 64px display serif, breathing on a quarter-screen of empty space, with the photograph extending edge-to-edge below it. No nav-bar links — only a logo and a single "Start free" CTA.

**Artifact comment:**

```html
<body>
  <!-- Taste: variance HIGH, motion EXPRESSIVE, density SPACIOUS. Signature: empty space as substance. Hero is one sentence, edge-bled photo, ken-burns at 4s. Refuse to add a feature grid — the brand is a feeling, not a checklist. -->
```

**Implementation rules:**
- Hero h1: 64px Fraunces serif, `text-wrap: balance`, max-width 18ch (forces a 3-line wrap).
- Feature sections are NOT cards. Each is a full-width row with one photograph (50% width) and one column of text (50% width). The text column alternates left and right between sections.
- Buttons have a 4px-thick `--accent` border, animate to filled-state on hover over 220ms.
- Scroll reveals: each section fades in over 600ms with a 24px translate-Y, easing `cubic-bezier(0.22, 1, 0.36, 1)`. Once per scroll, never on re-entry.
- `prefers-reduced-motion` removes the ken-burns and the scroll reveals; the page still works visually.

---

## Anti-patterns

- **Don't ship "all balanced everything."** That IS the slop. Pick at least one dial that's intentionally off-center.
- **Don't stack two HIGH dials without justification.** Variance HIGH + Density DENSE = visual noise. Variance HIGH + Motion EXPRESSIVE = a website that fights the reader. If you've picked two, ask: which one does the brand actually need? Drop the other.
- **Don't add a Bento grid by default.** Bento grids are the 2024 generic. If you're reaching for one, ask: would this brand still ship a Bento in three years, or is this just what every AI demo looks like? Most of the time, drop it and use a stacked editorial layout.
- **Don't add a gradient hero by default.** A gradient is fine; an unmotivated gradient is the AI tell. If you include one, the gradient should reference the brand's accent ramp specifically, not be a generic `from-purple-500 to-pink-500`.
- **Don't slap motion on everything.** A button that slides AND scales AND shadows AND glows on hover is four motion ideas competing. Pick one and remove the others.
- **Don't forget `prefers-reduced-motion`.** Every motion choice ships with the override. Without it, the page is hostile to a chunk of the audience.
- **Don't write the dials into the user's chat reply.** The dials are an internal discipline; the user gets the artifact and a one-line description ("This one's variance-medium, motion-subtle, signature is the oversized install command."). Don't dump the whole table on them.
