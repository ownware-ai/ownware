---
name: article-layout
description: Long-form HTML essay or magazine article layout. Drop caps, pull quotes, sidebar callouts, footnotes, byline + dateline, related-reading footer. Use when the brief is "essay", "blog post", "newsletter long-read", "magazine feature", or "convert these notes into a polished article". Skip for landing pages (use artifact + web-guidelines) or decks (use deck).
trigger: /article-layout
---

# Article Layout — magazine craft for a long read

## Overview

A long-form essay is not a blog post with bigger margins. It is a typographic composition: a measure narrow enough to read, a hierarchy that breaks the wall of text every 200–400 words, sidebar callouts that earn their interruption, footnotes that land where the eye wants them. This skill is the recipe for taking 800–2500 words of source content and rendering it as a *single self-contained HTML article* that reads like it came out of a magazine, not a CMS.

File shape: same as `artifact` (one HTML, `:root` tokens, `data-cx-id` regions). Layered on top: the magazine affordances catalogued below.

---

## Critical Constraints — read these first, every time

1. **Single column, narrow measure.** Body column `max-width: 65ch` (~ 680px at 16px / 1.6). Wider is academic-paper territory; narrower is mobile-only.
2. **Body type 18–20px on desktop.** Long-read is read slowly. 16px feels cramped past 1000 words. Use 18px / 1.7 line-height for serif body, 17–18px / 1.65 for sans body.
3. **Serif for body or serif for headlines — pick one.** Two-serif pairings work; two-sans pairings work; one-serif-one-sans is the most common combination. Sans body + sans display is the safe modern default; serif body + serif display is the Editorial Monocle look.
4. **Vertical rhythm tied to one baseline.** Pick a base value (e.g. 32px) and use multiples: paragraph spacing 32px, section spacing 64px, h2-to-body 24px. Random spacing = the article reads like a draft.
5. **Drop cap on opening paragraph only.** One drop cap. The next two paragraphs don't get one. If you can't help yourself, you're not designing — you're decorating.
6. **Pull quotes: one per 600–900 words, max.** Too many pulls turn the article into a sales page. The pull is a *pause*, not a feature.
7. **Footnotes link both ways.** `<sup><a href="#fn-1">1</a></sup>` in body and `<a href="#ref-1">↩</a>` back from the footnote. Without the back-link, the reader is stuck.

---

## The article's structural sections

Every article this profile produces follows this top-to-bottom order:

1. **`data-cx-id="masthead"`** — small wordmark or category label ("Essay", "Field notes", "Long read"), all caps, letter-spaced. Optional.
2. **`data-cx-id="title"`** — display-sized headline. `text-wrap: balance`. Generous bottom margin.
3. **`data-cx-id="byline"`** — author, dateline, reading time. One line, muted, separated by ` · ` middle dots.
4. **`data-cx-id="lede"`** — optional standfirst paragraph in larger body type (22–26px), italic or roman, sets the angle.
5. **`data-cx-id="body"`** — the article proper. Mix of `<p>`, `<h2>`, `<h3>`, `<blockquote class="pull">`, `<aside class="sidebar">`, `<figure>`, `<hr class="ornament">`.
6. **`data-cx-id="footnotes"`** — numbered list of footnotes, smaller type, with back-link arrows.
7. **`data-cx-id="related"`** — 2–4 related-reading cards. Title + one-line desc + outbound link.
8. **`data-cx-id="colophon"`** — credit, license, contact. Smallest type. Optional.

---

## Rubric — the magazine affordances

### Drop cap

CSS-only, no `<span>` wrapping. Use `::first-letter` on the opening paragraph.

```css
.body > p.opening::first-letter {
  float: left;
  font-family: var(--font-display);
  font-size: 5.5em;         /* about 4 baseline lines */
  line-height: 0.85;
  margin: 0.05em 0.08em 0 0;
  font-weight: 700;
  color: var(--accent);
}
```

### Pull quote

`<blockquote class="pull">` with a left border, oversized type, indented from the body column.

```css
.pull {
  margin: 48px -64px;       /* let it breathe out of the column on desktop */
  padding: 8px 32px;
  border-left: 4px solid var(--accent);
  font-family: var(--font-display);
  font-size: 28px;
  line-height: 1.25;
  text-wrap: balance;
  color: var(--fg);
}
@media (max-width: 760px) { .pull { margin: 32px 0; } }
```

### Sidebar callout

`<aside class="sidebar">` — short tangent or context block, visually distinct.

```css
.sidebar {
  background: var(--surface-2, #f5f3ee);
  border-left: 3px solid var(--muted);
  padding: 16px 20px;
  margin: 32px 0;
  font-size: 15px;
  line-height: 1.55;
  color: var(--muted);
}
.sidebar h4 {
  margin: 0 0 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

### Ornament divider (section break)

Centered glyph or short rule, not a full-width `<hr>`.

```css
hr.ornament {
  border: none;
  text-align: center;
  margin: 48px 0;
}
hr.ornament::before {
  content: "✦ ✦ ✦";       /* or "§" or "❦" or "* * *" */
  color: var(--muted);
  letter-spacing: 0.6em;
  font-size: 14px;
}
```

### Footnote affordance

In body: `<sup id="ref-1"><a href="#fn-1">1</a></sup>`. In footer:

```html
<ol class="footnotes">
  <li id="fn-1">Yes, even the Times still uses it. <a href="#ref-1">↩</a></li>
</ol>
```

Style:

```css
.footnotes { font-size: 14px; line-height: 1.55; color: var(--muted); }
.footnotes li { margin-bottom: 12px; }
sup a { text-decoration: none; color: var(--accent); }
```

### Byline + dateline

One line, mid-dot separators, muted. `font-size: 14px; color: var(--muted); margin: 0 0 32px;`. Author name underlined via `border-bottom: 1px solid var(--border);` rather than blue link styling.

### Related reading footer

2–4 cards in `<footer data-cx-id="related">`, equal width, minimal chrome. Each card has a bold title and a one-line description. Grid: `display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;` inside the 65ch column.

---

## Concrete examples

### Example 1 — worked: a 1200-word essay using every affordance

Hypothetical essay "The patience of typography." Section-by-section build:

- **Masthead:** `ESSAY · CRAFT`, 12px caps, `letter-spacing: 0.12em`, muted.
- **Title:** display serif 56px, `line-height: 1.05`, `text-wrap: balance`, 32px below.
- **Byline:** "By Lena Rivas · February 14, 2026 · 9 min read", 14px muted, mid-dots.
- **Lede:** italic 24px / 1.5 standfirst stating the angle in one paragraph.
- **Body open:** opening paragraph carries the drop cap; next paragraphs do not.
- **Subhead at ~300 words:** display serif 32px, 64px top, 16px bottom.
- **Pull quote at ~600 words:** one crystallized claim, accent left border, breathes out of the column.
- **Sidebar at ~800 words:** `<aside>` titled "FIELD NOTE", muted background, 60-word digression.
- **Ornament between movements:** three glyphs centered, 48px above and below.
- **Footnote near a contentious claim:** `<sup>1</sup>` in body, back-linked entry in the footer.
- **Related reading:** two cards in the footer.
- **Colophon:** one line crediting the type stack.

That's the full kit, one essay, paste-ready.

### Example 2 — token block for the Editorial Monocle direction applied to article-layout

```css
:root {
  --bg: #fafaf7;
  --surface: #ffffff;
  --surface-2: #f5f3ee;
  --fg: #1a1a1a;
  --muted: #6b6b6b;
  --border: #e8e6e0;
  --accent: #8b0000;             /* deep burgundy, the magazine signature */
  --radius: 0;
  --font-display: "Iowan Old Style", "Georgia", "Times New Roman", serif;
  --font-body: "Iowan Old Style", "Georgia", serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
body {
  font: 19px/1.7 var(--font-body);
  background: var(--bg);
  color: var(--fg);
  text-wrap: pretty;
}
.body { max-width: 65ch; margin: 0 auto; padding: 0 24px; }
```

Burgundy accent, serif body, narrow measure, generous line-height. That's the magazine voice.

---

## Anti-patterns

- **Drop caps on every paragraph or every section opener.** Stop. One drop cap, opening paragraph only. More is parody.
- **Pull quotes that quote the next sentence.** Stop. The pull should be a *crystallized* claim, not a duplicate. If the pull and the next paragraph say the same thing, cut one.
- **`max-width: 100%` on the body column.** Stop. Cap at `65ch` (~680px). Lines wider than that drop your eyes' return-sweep accuracy.
- **A `<hr>` between every section.** Stop. The h2 itself is the section break; the ornament is for *thematic* breaks (e.g. between Act II and Act III).
- **Footnotes without back-links.** Stop. The reader is now lost. Always pair `id="ref-N"` with `id="fn-N"` and an `↩`.
- **Stock-photo hero at the top of every article.** Stop. If you can't think of a real, specific image, skip it. A strong title on a clean field beats a generic cityscape every time.
- **Sans-serif body at 14px.** Stop. 18px minimum on long-read. The user is reading 1500 words, not a tooltip.
