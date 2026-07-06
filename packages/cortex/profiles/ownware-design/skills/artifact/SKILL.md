---
name: artifact
description: The structural blueprint for writing the canonical HTML artifact. Use after discovery is locked in. Defines the exact file shape (doctype, :root tokens, component CSS using var(), data-cx-id anchors), the surgical-edit discipline (Edit between data-cx-id tags, never rewrite the whole file), and the artifact handoff convention.
trigger: /artifact
---

# Artifact — write the file the right way

## Overview

This is the workhorse. Every landing page, dashboard, mock, brand sheet, magazine, and prototype this profile produces follows the structure described here. Decks are a special case — see the `deck` skill. Critiques use `critique`.

If you find yourself improvising the file structure ("maybe I'll put the tokens in a separate file…", "maybe React components in their own files…"), stop. The shape below is non-negotiable v0.1. Improvisation produces files that don't preview cleanly and don't edit surgically.

---

## Critical Constraints — read these first, every time

1. **One file.** Inline `<style>`. Inline `<script>`. No external CSS files. No bundler. No `npm install`. Multi-page artifacts are multiple self-contained files linked by `<a href>`, each duplicating the `:root` block.
2. **Tokens first, in `:root`, hex colors only in this block.** Every CSS rule below references `var(--…)`. A hardcoded hex outside `:root` is a smell — fix on sight.
3. **`data-cx-id="…"` on every top-level region of the body.** Hero, sections, cards-grid, sidebar, topbar, KPI row, panel-row, footer, every slide. Without these anchors, edits cascade across the whole file.
4. **Write `index.html` as the canonical entry.** Other pages get their own descriptive filenames (`pricing.html`, `about.html`). For major rewrites, copy the existing file to a versioned name first (`landing.html` → `landing-v1.html`) before overwriting.
5. **No `scrollIntoView`** — it breaks the embedded preview. Use `window.scrollTo({ top, behavior })` or anchor links.
6. **Keep individual files under ~1000 lines.** If you're approaching that, split the artifact (e.g. landing + pricing into two files). Do not split a single artifact into multiple HTML files for organisation only.

---

## The file shape

Every artifact this profile produces follows this exact order, top to bottom. Memorize it.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{Descriptive title}</title>
  <style>
    /* 1. TOKENS — :root block, from the chosen direction, plus any user overrides */
    :root {
      --bg: …; --surface: …; --fg: …; --muted: …; --border: …;
      --accent: …; --accent-hover: …; --accent-fg: …;
      --good: …; --warn: …; --bad: …;
      --radius: …; --radius-pill: …;
      --font-display: …; --font-body: …; --font-mono: …;
    }

    /* 2. RESETS / GLOBALS */
    *, *::before, *::after { box-sizing: border-box; }
    body  { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--font-body); text-wrap: pretty; }
    h1, h2, h3, h4 { font-family: var(--font-display); letter-spacing: -0.01em; line-height: 1.2; text-wrap: balance; }

    /* 3. COMPONENT CSS — every rule references var(--…), grouped by region */
    .hero        { … }
    .features    { … }
    .panel       { … }
    .btn-primary { background: var(--accent); color: var(--accent-fg); … }
    .pill.good   { color: var(--good); … }
    /* … */

    /* 4. RESPONSIVE — media queries or container queries, last */
    @media (max-width: 900px) { … }
  </style>
</head>
<body>
  <!-- Every top-level region carries data-cx-id="…" -->
  <header data-cx-id="topnav">…</header>
  <section data-cx-id="hero">…</section>
  <section data-cx-id="features">…</section>
  <section data-cx-id="proof">…</section>
  <section data-cx-id="pricing-cta">…</section>
  <footer data-cx-id="footer">…</footer>

  <!-- Inline scripts last, if needed -->
  <script>
    // Direct DOM manipulation. No frameworks unless explicitly requested.
  </script>
</body>
</html>
```

That's the whole structure. Tokens → globals → component CSS → responsive → body with anchors → optional script. In that order.

---

## Naming conventions

### `data-cx-id` values

Use kebab-case, descriptive of *role* not *position*. Good: `hero`, `pricing-cards`, `customer-logos`, `footer-cta`. Bad: `section-1`, `section-2`, `top-thing`.

For repeated groups, name the *group*, not the items: `data-cx-id="pricing-cards"` on the wrapper, not on each card. Then each card inside can have a sub-id if it earns one (`data-card="starter"`, `data-card="pro"`).

For decks, slides are numbered with their role: `data-cx-id="slide-1-cover"`, `data-cx-id="slide-2-problem"`. See `deck` skill.

### CSS class names

Stay descriptive and BEM-ish without dogma. `.hero`, `.hero-title`, `.hero-actions`, `.btn`, `.btn-primary`, `.btn-secondary`. Avoid utility soup; this is not Tailwind.

### File names

- `index.html` — the canonical entry.
- `pricing.html`, `about.html`, `changelog.html` — sibling pages.
- `landing-v1.html`, `landing-v2.html` — versioned snapshots of significant revisions.

---

## Surgical editing — the rule under the rule

When the user asks for a change to an existing artifact, the diff should be small. Examples below.

### Single token change ("the accent should be Stripe purple")

```
- --accent: #2f6feb;
+ --accent: #635bff;
```

One line. The whole preview re-flows because every button, link, focus ring, and chart line references `var(--accent)`. No other line moves.

### Single component style change ("kpi cards too tight")

```
- .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
+ .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px 26px; }
```

One rule. Edit that rule's contents. Leave the rest.

### Single region rewrite ("swap the chart panel for a stepped line chart")

Edit between `<div class="panel" data-cx-id="chart-panel">` and its closing `</div>`. Leave every other region untouched.

### Wholesale rewrite ("scrap the direction, redo it")

This is the exception. Say so out loud first: "Going to rewrite the artifact since the direction is changing — saving the current version to `landing-v1.html` so we can compare." Then `Write` the new `index.html`.

### Adding a new region

If the user asks for a new section ("add a FAQ between proof and CTA"), Edit the body to splice in the new region between the right anchors. Add component CSS for the new region above the responsive block. Add `data-cx-id="faq"` to the new wrapper.

---

## React + inline JSX (only when interactivity demands it)

Static HTML covers 90% of artifacts. When the user explicitly wants interactivity that needs state, use React via CDN with pinned versions:

```html
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>
```

Then:

- `<script type="text/babel">` for JSX blocks. Each block has its own scope; share components via `window.MyComponent = MyComponent` at the end of one block, then read from `window` in the next.
- **Never** `<script type="module">` — breaks Babel transpile.
- **Never** bare `const styles = {…}` — name style objects by component (`const heroStyles = {…}`, `const tableStyles = {…}`). Two files with the same `styles` name will collide.
- Inline styles are fine when they're tiny and one-off.

For state, prefer `useState` + `useReducer`. No Redux, no Zustand, no MobX. The whole point is "one file."

---

## Inline SVG charts

For dashboards and reports, draw charts inline as `<svg>`. No Chart.js, no D3, no recharts. A polyline / path with computed `points` is enough for 95% of the cases.

```html
<svg viewBox="0 0 600 240" preserveAspectRatio="none">
  <polyline fill="none" stroke="var(--accent)" stroke-width="2"
    points="0,180 30,170 60,150 90,160 120,140 150,120 …" />
</svg>
```

The values can be hardcoded (for a mock) or computed via inline JS (for a live prototype). Either way, the chart lives in the same file. No external libraries unless the user explicitly asks.

---

## Images and visual references

When the user attaches an image as a reference:

- **Read it.** Lift palette, type direction, density, signature move. Describe back what you'd lift.
- **Don't embed the user's image into the artifact** unless they explicitly ask. Reference it by path if you do (`<img src="./hero-source.png">`). Most of the time, use a placeholder block (`<div class="image-placeholder">Hero photo</div>`) and let the user supply the real asset later.
- **Don't claim pixel-perfect recreation** unless the brief explicitly asks for it. Match the *system*; don't trace the page.

---

## The reply after writing (never re-emit the file)

The canvas renders the file the moment your `writeFile` / Edit lands — it reads the file from **disk**, not from your message. So your reply must never contain the file's contents.

- **No `<artifact>` block.** No fenced HTML. No walking through the markup. Re-emitting the document dumps the whole file into the chat as raw text — it duplicates what's already on the canvas and buries the conversation.
- **Reply with one or two lines:** which file changed, what changed, and — if it helps — the one thing you'd suggest next. `Wrote index.html — Modern Minimal landing, cobalt accent, stepped-chart hero. Want me to tighten the supporting sections?`
- **Edits get the same treatment:** a short "changed the pricing cards' padding in `index.html`" line, nothing more.

The artifact lives on the canvas. Your message is the conversation about it — keep it short.
