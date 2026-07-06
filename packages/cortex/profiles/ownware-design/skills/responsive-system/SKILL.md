---
name: responsive-system
description: 'Set breakpoints, decide mobile-first vs desktop-first, wire container queries, and use clamp() for fluid type and spacing — the responsive bedrock under every artifact. Use whenever the artifact must work on more than one viewport (almost always). Pairs with /layout-grids (which grid at which breakpoint) and /web-guidelines (the numeric baselines this skill builds on). Skip when the artifact is explicitly desktop-only (presentation deck on a fixed canvas, kiosk screen, single-viewport mock).'
trigger: /responsive-system
---

# Responsive System — fluid type, container queries, four breakpoints that earn their keep

## Overview

Most "responsive" artifacts are six breakpoints copy-pasted from Bootstrap and zero thought about which one actually matters. This skill rejects that pattern. Pick the breakpoints that map to the user's real devices. Use container queries for component-level responsive (the card doesn't care what the viewport is — it cares what the column is). Use `clamp()` for fluid type and spacing so the design stops "stepping" between breakpoints and starts breathing.

This skill produces four artifacts: (1) a chosen breakpoint set, (2) a mobile-first vs desktop-first call, (3) container-query patterns for components, (4) `clamp()` rules for type + spacing. Every value is a token in `:root` or a single inline `clamp()` call.

Pair with `/layout-grids` (which grid lives at which breakpoint) and `/web-guidelines` (where the numeric defaults come from).

---

## Critical Constraints

1. **Four breakpoints maximum.** Six is bootstrap-cargo. Pick the four that map to real devices: a phone, a tablet, a laptop, a wide desktop. Drop the rest. Each breakpoint that ships must change something visible — never a breakpoint that only changes padding by 4px.
2. **Mobile-first for marketing / consumer / content sites.** Desktop-first for dashboards / admin / B2B tooling. The rule isn't preference — it's where the user starts. A marketing visitor lands on a phone (50%+ of traffic). A dashboard user logs in from their work laptop.
3. **Container queries for components.** A card grid that switches from 3-col to 2-col to 1-col belongs in `@container`, not `@media` — the card grid might live in a sidebar (narrow) or main content area (wide) at the same viewport.
4. **`clamp()` for hero type and section padding.** Step-changes at breakpoints make headlines "jump" sizes. `clamp(40px, 7vw, 76px)` flows smoothly. Use clamp anywhere a value scales with viewport (hero size, section padding, side gutters).
5. **Test at 320px, 768px, 1024px, 1440px.** Not "looks good on my MacBook." If you can't open the artifact in DevTools and step those four widths, you haven't tested responsive.
6. **Touch targets stay 44px+ on every viewport.** A "compact" desktop layout that shrinks a button to 36px breaks on a touch laptop. The minimum doesn't get smaller because the screen got bigger.

---

## Framework — the four steps

### Step 1 — Pick four breakpoints (from the standard six)

The full menu (snapped to common device groupings):

| Token | px | Device tier | Earns it? |
|-------|----|-------------|-----------|
| `--bp-xs` | 320 | iPhone SE, smallest phones | Yes — design has to fit here |
| `--bp-sm` | 480 | Large phones | Sometimes — skip if `xs` and `md` cover the work |
| `--bp-md` | 768 | Tablets, small laptops | Yes — major layout shift point |
| `--bp-lg` | 1024 | Laptops, iPad landscape | Yes — desktop layout starts here |
| `--bp-xl` | 1280 | Standard desktop | Sometimes — bundle with `lg` if no real change |
| `--bp-2xl` | 1440 | Wide desktop, designer monitors | Yes — container max-width often lives here |

**Default 4-set for marketing/product:**

```css
:root {
  --bp-sm:  480px;   /* phone landscape, small tablet */
  --bp-md:  768px;   /* tablet portrait */
  --bp-lg:  1024px;  /* laptop */
  --bp-xl:  1440px;  /* wide desktop, max container */
}
```

**Default 4-set for dashboards** (skip 480, add 1680):

```css
:root {
  --bp-md:  768px;   /* mobile-tablet — collapsed admin */
  --bp-lg:  1024px;  /* laptop — primary work surface */
  --bp-xl:  1440px;  /* desktop */
  --bp-2xl: 1680px;  /* wide / multi-monitor */
}
```

### Step 2 — Mobile-first vs desktop-first

| Artifact type | Direction | Reason |
|---------------|-----------|--------|
| Marketing landing | Mobile-first | 50%+ of traffic lands on a phone. Build the small case, layer up. |
| Consumer app | Mobile-first | Touch-first; desktop is the polish layer. |
| Long-form content / blog / docs | Mobile-first | Reading happens everywhere. |
| Internal dashboard | Desktop-first | Users are on a work laptop; mobile is the "viewing while away from desk" case. |
| Admin UI / config screens | Desktop-first | Density and data tables are the point. |
| Presentation deck | No responsive | Fixed 1280×720 canvas. Skip the system. |

**Mobile-first pattern:**

```css
/* base styles are the mobile case */
.hero { padding: 48px 24px; }
.hero h1 { font-size: 40px; }

/* add up as viewport grows */
@media (min-width: 768px) {
  .hero { padding: 80px 32px; }
  .hero h1 { font-size: 56px; }
}
@media (min-width: 1024px) {
  .hero { padding: 120px 48px; }
  .hero h1 { font-size: 72px; }
}
```

**Desktop-first pattern (dashboards):**

```css
/* base styles are the desktop case */
.dashboard { grid-template-columns: 240px 1fr 320px; gap: 32px; }

/* strip down as viewport shrinks */
@media (max-width: 1024px) {
  .dashboard { grid-template-columns: 200px 1fr; }      /* drop the right rail */
  .right-rail { display: none; }
}
@media (max-width: 768px) {
  .dashboard { grid-template-columns: 1fr; }            /* drop the sidebar */
  .sidebar { display: none; }                            /* show a hamburger instead */
}
```

### Step 3 — Container queries for component responsive

A card grid that switches columns shouldn't depend on the viewport — it should depend on the column it's sitting in. The same card grid might live in a 1200px main area (3-col) or a 320px sidebar (1-col) on the same desktop viewport.

```css
.card-grid {
  container-type: inline-size;
  container-name: cardgrid;
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@container cardgrid (min-width: 480px) {
  .card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
}
@container cardgrid (min-width: 720px) {
  .card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
}
```

Container-query support: Chrome 105+, Safari 16+, Firefox 110+. Safe to use unconditionally in 2026.

### Step 4 — `clamp()` for fluid scale

The `clamp(min, preferred, max)` function caps a fluid value at both ends:

```css
:root {
  /* fluid hero size — 40px on phone, 76px on wide desktop, scales smoothly between */
  --text-hero: clamp(40px, 7vw, 76px);

  /* fluid section padding — 48px tight on mobile, 120px airy on desktop */
  --pad-section: clamp(48px, 10vw, 120px);

  /* fluid side gutter — 24px on phone, 48px on desktop */
  --pad-side: clamp(24px, 4vw, 48px);

  /* fluid body type — 16px default, lifts to 18px on long-form layouts */
  --text-body: clamp(16px, 1vw + 0.875rem, 18px);
}

.hero { padding: var(--pad-section) var(--pad-side); }
.hero h1 { font-size: var(--text-hero); }
section { padding-block: var(--pad-section); padding-inline: var(--pad-side); }
```

The math: `7vw` at 320px viewport = 22.4px (clamped to 40px floor). At 1080px = 75.6px (just under 76px ceiling). At 1440px = clamped to 76px. The size flows smoothly from phone to laptop, then stops growing past wide desktop — exactly what you want.

**Fluid scale rule of thumb:** `clamp(MIN, A·vw + B·rem, MAX)`. `A` controls how fast it scales; `B` raises the floor at small viewports.

---

## Concrete examples

### Example 1 — Hero block, fluid clamp + container-query card grid below

```html
<section data-cx-id="hero" class="hero">
  <h1>Build it once. Ship it everywhere.</h1>
  <p class="hero-sub">A platform that flexes with your team.</p>
  <a class="btn-primary" href="#">Start free</a>
</section>

<section data-cx-id="features" class="features-container">
  <div class="card-grid">
    <article class="card">…</article>
    <article class="card">…</article>
    <article class="card">…</article>
    <article class="card">…</article>
    <article class="card">…</article>
    <article class="card">…</article>
  </div>
</section>
```

```css
:root {
  --pad-section: clamp(48px, 10vw, 120px);
  --pad-side:    clamp(24px, 4vw, 48px);
  --text-hero:   clamp(40px, 7vw, 76px);
  --text-sub:    clamp(18px, 1vw + 1rem, 22px);
}

.hero {
  max-width: 1200px;
  margin-inline: auto;
  padding: var(--pad-section) var(--pad-side);
  text-align: center;
}
.hero h1 { font-size: var(--text-hero); line-height: 1.05; letter-spacing: -0.02em; text-wrap: balance; max-width: 18ch; margin-inline: auto; }
.hero-sub { font-size: var(--text-sub); color: var(--muted); max-width: 56ch; margin: 24px auto 32px; }

.features-container { max-width: 1200px; margin-inline: auto; padding: var(--pad-section) var(--pad-side); }
.card-grid {
  container-type: inline-size;
  container-name: features;
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@container features (min-width: 480px) {
  .card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
}
@container features (min-width: 768px) {
  .card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
}
```

Why it works: hero flows smoothly from 320px to 1440px — no breakpoint "jump." The card grid switches column count based on its own width, not the viewport — drop it into a sidebar and it'd switch to 1-col without touching media queries. Section padding ramps up with viewport: 48px on phone, 120px on desktop, all from one `clamp()`.

### Example 2 — Dashboard with desktop-first 3-col → 2-col → 1-col

```html
<div class="dashboard">
  <aside class="dashboard-sidebar">…nav…</aside>
  <main class="dashboard-main">…content…</main>
  <aside class="dashboard-rail">…activity feed…</aside>
</div>
```

```css
:root {
  --bp-md:  768px;
  --bp-lg:  1024px;
  --bp-xl:  1440px;
  --bp-2xl: 1680px;
}

/* desktop-first — base = laptop+ */
.dashboard {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 320px;
  gap: 24px;
  max-width: 1680px;
  margin-inline: auto;
  padding: 24px;
  min-height: 100vh;
}

/* laptop narrow — drop right rail */
@media (max-width: 1280px) {
  .dashboard { grid-template-columns: 220px minmax(0, 1fr); }
  .dashboard-rail { display: none; }
}

/* tablet — collapse sidebar, show as drawer instead */
@media (max-width: 768px) {
  .dashboard { grid-template-columns: minmax(0, 1fr); padding: 16px; gap: 16px; }
  .dashboard-sidebar { display: none; }   /* hamburger trigger reveals it as overlay */
}
```

Why it works: a real dashboard user opens it on a 1440px monitor — that's the base case. Going smaller, the system strips features in order of importance: activity feed first (it's secondary), sidebar second (it's navigation, swap to a drawer). The breakpoints are placed where the layout *needs* to change, not at arbitrary Bootstrap widths.

---

## Anti-patterns

- **Six breakpoints, each changing 4px of padding.** Stop. If the change isn't visible at a glance, the breakpoint isn't earning its keep. Merge it into the next one.
- **Mobile-first on a dashboard.** Stop. Dashboards live on laptops. A mobile-first dashboard means the desktop case is layered on top of a stripped-down base — every desktop rule is a "min-width" override. Flip it: desktop is the base; strip features down for narrower viewports.
- **`@media (min-width: 1280px)` inside a card component.** Stop. The card might live in a sidebar at the same viewport. Container queries (`@container`) are the right tool.
- **`width: 100vw` on a section.** Stop. `100vw` includes the scrollbar width, causing horizontal scroll on Windows. Use `width: 100%` and let the parent constrain.
- **Hiding entire navigation `display: none` on mobile with no replacement.** Stop. You hid the nav. Now the user can't navigate. Replace it with a hamburger / drawer / bottom-tab — a real mobile pattern, not a deletion.
- **`font-size: 14px` "to fit on mobile."** Stop. 16px minimum. Below that iOS Safari zooms inputs and breaks tap targets. If the layout needs smaller type to fit, the layout is wrong, not the type.
- **No `clamp()` anywhere — six breakpoints with stepped `font-size` jumps.** Stop. The hero "jumping" from 40 → 48 → 56 → 72px at four breakpoints reads as a glitch. `clamp(40px, 7vw, 76px)` flows. One rule replaces four media queries.
- **Forgetting to test at 320px.** Stop. iPhone SE is still in active use. If the artifact breaks at 320px (horizontal scroll, overflowing card, clipped headline), it breaks for a real user.
