---
name: guizang-editorial-deck
description: 'Editorial-magazine deck pattern — two-tone palette (deep navy + cream), Italian-style high-contrast serif headlines, pull-quote slides as 50% of the deck, paper-print aesthetic. Use when the brief is narrative, opinion, founder voice, or thought-leadership — not when the deck is a data dashboard, a sales board, or a product walkthrough. Always defers to /deck for the 1920×1080 framework; this skill supplies palette, type, and slide-mix discipline on top.'
trigger: /guizang-editorial-deck
---

# Editorial Deck — magazine spread, not slide layout

## Overview

This is a deck variant for narrative work — a founder essay turned into slides, an opinion piece, a "year in review" letter, a manifesto. The mood is luxury print magazine: a single restrained two-tone palette, a high-contrast serif headline, generous white space, half the deck given over to pull-quotes. Editorial confidence, not corporate signage.

Layer this on top of `/deck`. The 1920×1080 canvas, scaling logic, keyboard nav, and print stylesheet come from there. This skill supplies the palette, type, slide mix, and per-slide composition discipline.

---

## Critical Constraints

1. **Two-tone palette, hex-locked, no third color.** Pick one of the five palettes below and do not mix them within a deck. The accent (kicker / folio / hairline rule) is a SHADE of the ink, not a separate color.
2. **Serif display, sans body.** Italian-style high-contrast serif (Playfair Display, Source Serif Pro, or "Iowan Old Style") for headlines. Inter or system-ui for body. Never the other way around.
3. **50% pull-quote slides.** In a 10-slide deck, 4 to 6 are pull-quote-only slides. The remaining are cover, dividers, big numbers, and one closing. Avoid eight-bullet content slides — if you reach for one, split into two pull-quote slides.
4. **No gradients, no drop-shadows, no rounded corners, no emoji decoration.** This is print. Borders are 1px hairlines. Edges are square. Decoration is the enemy.
5. **Folio at lower right.** `01 / 12` in body font, 14px, ink-tint color. Every slide. Cover excluded.
6. **Hairline rule + topic label at top.** 1px ink-tint line at y=120px, with a small uppercase kicker `THE ESSAY · 2026` above the rule on every slide. Cover and closing excluded.

---

## The five locked palettes

Pick ONE for the whole deck. Do not mix.

1. **Ink Classic** — `--ink: #0a0a0b`, `--paper: #f1efea`, `--paper-tint: #e8e5de`, `--ink-tint: #18181a`. Default. Works for tech, opinion, founder voice.
2. **Indigo Porcelain** — `--ink: #0a1f3d`, `--paper: #f1f3f5`, `--paper-tint: #e4e8ec`, `--ink-tint: #152a4a`. Works for research, deep tech, data narratives.
3. **Forest Ink** — `--ink: #1a2e1f`, `--paper: #f5f1e8`, `--paper-tint: #ece7da`, `--ink-tint: #253d2c`. Works for nature, sustainability, cultural pieces.
4. **Kraft** — `--ink: #2a1e13`, `--paper: #eedfc7`, `--paper-tint: #e0d0b6`, `--ink-tint: #3a2a1d`. Works for nostalgic, literary, humanist briefs.
5. **Dune** — `--ink: #1f1a14`, `--paper: #f0e6d2`, `--paper-tint: #e3d7bf`, `--ink-tint: #2d2620`. Works for art, design, fashion-adjacent work.

Paste straight into `:root`:

```css
:root {
  --ink: #0a0a0b;
  --paper: #f1efea;
  --paper-tint: #e8e5de;
  --ink-tint: #18181a;
  --font-display: "Playfair Display", "Iowan Old Style", Georgia, serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
body { background: var(--paper); color: var(--ink); font-family: var(--font-body); }
```

---

## The slide mix — 10-slide reference deck

For a typical 10-slide editorial deck, the mix is:

1. **Cover** — single 9vw serif headline, kicker line above (issue + date), tiny author name at bottom. No image. The deck title IS the design.
2. **Act divider** — kicker `ACT I` in 11px uppercase letterspacing 0.12em, headline at 8.5vw centered, one-line lead beneath. Optional reverse (ink background, paper text) for chapter breaks.
3. **Big-numbers grid** — 3-up of large data figures, each at 5.5vw, label at 14px uppercase, footnote at 12px. The number IS the point; do not bury it in prose.
4. **Pull-quote** — single quote at 4.5vw italic serif, attribution beneath in 16px caps, breathing margin top+bottom. Quotation marks at the start in 6vw `--ink-tint`.
5. **Pull-quote** — second one, different mood. Vary scale slightly (4 to 5vw) to keep the deck breathing.
6. **Image + caption** — placeholder image block left, headline + 2-paragraph body right. Image is 16:10, aligned to baseline of headline (not top). No drop-shadow.
7. **Pull-quote** — third one.
8. **Hero question** — one 7vw question slide. Centered. Surrounding is empty. Used to mark a pivot.
9. **Pull-quote** — fourth one.
10. **Closing** — single 5vw line, author name, sign-off. No CTA button (this is editorial, not marketing).

If the user has more content, repeat layouts. Don't invent new ones.

---

## Concrete examples

### Example A — Ownware "Founder essay: Why local-first" deck

Brief: 800-word essay turned into a 10-slide narrative deck. Audience: investors + early users.

Direction: **Ink Classic** palette. Playfair Display serif. The headline is the essay's title.

```html
<!-- Slide 1: Cover -->
<section class="slide active" data-screen-label="01 Cover" data-cx-id="slide-1-cover">
  <div class="rule">THE ESSAY · 2026</div>
  <h1>The credentials should live where the customer lives.</h1>
  <div class="author">Sam Rivera · Ownware</div>
</section>

<!-- Slide 4: Pull-quote -->
<section class="slide" data-screen-label="04 Quote" data-cx-id="slide-4-quote">
  <div class="rule">THE ESSAY · 2026</div>
  <blockquote>
    <span class="quote-mark">"</span>
    Zero centralized OAuth. Zero shared secrets. Zero data on Ownware servers — they don''t exist.
  </blockquote>
  <cite>— Ownware Principle 5</cite>
  <div class="folio">04 / 10</div>
</section>
```

CSS:

```css
.slide h1 { font: 600 9vw/1.05 var(--font-display); letter-spacing: -0.02em; max-width: 14ch; }
blockquote { font: italic 500 4.5vw/1.2 var(--font-display); max-width: 22ch; }
.quote-mark { font: italic 700 6vw var(--font-display); color: var(--ink-tint); }
cite { display: block; font: 600 14px/1.4 var(--font-body); letter-spacing: 0.18em; text-transform: uppercase; margin-top: 32px; font-style: normal; }
.rule { position: absolute; top: 120px; left: 128px; right: 128px; border-top: 1px solid var(--ink-tint); padding-top: 14px; font: 600 11px/1 var(--font-body); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-tint); }
.folio { position: absolute; right: 128px; bottom: 64px; font: 500 14px var(--font-body); color: var(--ink-tint); }
```

### Example B — "Ownware Q3 retrospective" deck

Brief: 7-slide internal retrospective. Mix of numbers + reflections.

Direction: **Indigo Porcelain** palette. 1 cover, 1 act divider, 1 big-numbers grid (3 KPIs), 3 pull-quotes (each a learning), 1 closing. The numbers are not gloated about; they are framed and then the deck moves on. The reflections carry the deck.

---

## Anti-patterns

- **Adding a third color.** Stop. The whole power of this skill is the two-tone restraint. A third color drops the deck into "corporate" and kills the editorial mood.
- **Bullet lists.** Stop. If you are reaching for a bullet list, the slide should be a pull-quote (pick the strongest bullet) or two slides.
- **Sans-serif headlines.** Stop. The high-contrast serif IS the deck. Sans headlines on this palette read as "boring whitepaper", not editorial.
- **Rounded corners on quote slides or images.** Stop. Print is square. Radius destroys the print feel.
- **Decorative emoji or icon library glyphs.** Stop. The kicker is the only ornament. If you want a flourish, increase the size of the quotation mark.
- **A deck that is 90% content slides and 10% quotes.** Stop. You have written a doc, not an editorial. Flip the ratio: at least half the deck is quotes.
