---
name: kami-parchment-doc
description: 'Parchment-styled long-form document for manifestos, declarations, and printed-feeling one-pagers — aged paper background with subtle grain, single serif throughout, sepia ink, single ink-blue accent, hairline rules. Use when the brief is "product manifesto", "principles document", "design philosophy", or "letter to the team". Skip for dashboards, web landing pages (use /artifact), and content under 300 words.'
trigger: /kami-parchment-doc
---

# Parchment Document — composed pages, ink, hairlines

## Overview

Some documents shouldn't look like a web page. A manifesto, a set of company principles, a design philosophy — these need to feel composed, not scrolled. This skill is the recipe for that: warm parchment paper, one ink color, one accent (a single ink blue), one serif family, hairline rules instead of borders.

The discipline is "this could have been printed and it would still look right." Think Field Notes books, Aesop product cards, the title page of a small-press novel. Pair with `/artifact` for file shape; the affordances below are the style layer.

---

## Critical Constraints — read these first, every time

1. **Parchment paper background, never white.** `--bg: #F5F4ED` (warm parchment). Pure `#FFF` breaks the printed-page illusion instantly.
2. **One ink color for body, one accent for emphasis.** `--ink: #1F1D18` (warm near-black) for all body. `--accent: #1B365D` (ink blue) for the kicker, links, the one tag chip, and a single rule. No other colors. Ever.
3. **One serif family for the entire document.** Body, headings, captions — same family at different sizes/weights. Mixing display + body serifs reads as web-magazine; one family reads as printed.
4. **No drop shadows, no glow, no radius ≥ 8px.** Pages don't have drop shadows. Tags get 0–4px radius. The whole identity falls apart if you add card shadows.
5. **Hairline rules, not borders.** Section dividers are `1px solid var(--rule)` with `--rule: #D6D2C5` (paper-toned hairline) and they don't span the full width — they run for ~120px or stop at a deliberate point.
6. **Body weight 400, heading weight 500 — never bold-bold.** A serif at weight 700+ on parchment reads as advertising. Weight 500 reads as a printed heading.

---

## The token block (paste verbatim into `:root`)

```css
:root {
  --bg: #F5F4ED;             /* warm parchment */
  --paper-2: #EFEEE5;        /* one tone deeper for tinted blocks */
  --ink: #1F1D18;            /* warm near-black, never #000 */
  --muted: #6B665B;          /* faded ink for captions, folio numbers */
  --rule: #D6D2C5;           /* hairline rule */
  --accent: #1B365D;         /* single ink blue */
  --grain: rgba(31, 29, 24, 0.025);
  --font-serif: "Charter", "Source Serif Pro", "Iowan Old Style", "Georgia", serif;
  --font-italic-display: "Charter Italic", "Iowan Old Style", "Georgia", serif;
}
body {
  margin: 0;
  background:
    radial-gradient(circle at 50% 50%, transparent 0%, var(--grain) 100%),
    var(--bg);
  color: var(--ink);
  font: 16px/1.55 var(--font-serif);
  text-wrap: pretty;
}
```

The radial grain is the subtle aging — a hint of darker tone at the edges that reads as paper-on-light without becoming a vignette photo effect. Keep `--grain` ≤ 3% opacity.

---

## Rubric — the parchment affordances

### 1. Page frame (the deckle-edge effect)

The whole document sits inside a max-width container with a hairline 1px ink shadow that reads as a deckle-edge.

```css
.page {
  max-width: 720px;
  margin: 64px auto;
  padding: 96px 80px;
  box-shadow: 0 0 0 1px var(--rule);  /* hairline ring, NOT drop shadow */
  background: var(--bg);
}
@media (max-width: 760px) {
  .page { margin: 0; padding: 56px 24px; box-shadow: none; }
}
```

The `box-shadow: 0 0 0 1px` is a hairline ring, not a drop shadow — it reads as the edge of a paper card. Drop shadows turn this into a web card and break the voice.

### 2. Folio number (top-corner, like a printed page)

```css
.folio { position: absolute; top: 48px; right: 80px;
         font: 400 12px/1 var(--font-serif); letter-spacing: 0.18em;
         color: var(--muted); text-transform: uppercase; }
```

Reads as "FOLIO · 01" or "ISSUE №14 · 2026" — top-right, small, lettered. The single design touch that says "this is a page."

### 3. Kicker (above the title, ink-blue caps)

```css
.kicker { color: var(--accent); font: 500 12px/1 var(--font-serif);
          letter-spacing: 0.14em; text-transform: uppercase; }
```

One line of ink-blue letter-spaced caps. "DECLARATION." or "PRINCIPLES, VOL I." or "A LETTER TO THE TEAM."

### 4. Title (large serif, 500 weight)

```css
h1.title { font: 500 48px/1.1 var(--font-serif);
           margin: 16px 0 8px; text-wrap: balance;
           letter-spacing: -0.01em; }
```

Never 700+. A 500-weight serif at 48px reads composed. A 700-weight serif at the same size reads like a CMS theme.

### 5. Italic display lockup (signature, byline, attribution)

```css
.attribution { font-style: italic; font-size: 16px;
               color: var(--muted); margin: 24px 0 56px; }
```

"— *Sam Cho, for the founding team*", italic, muted, with the em-dash. The single piece of typographic personality in the doc.

### 6. Numbered principles (the workhorse pattern)

For manifesto-style content, the body is numbered articles, each with a tiny ink-blue number kicker.

```html
<section class="article">
  <span class="article-num">01.</span>
  <h2>Reliability is the product.</h2>
  <p>Reliability is not "tests pass." Reliability is a real user…</p>
</section>
```

```css
.article { margin: 56px 0; }
.article-num { color: var(--accent); font: 500 14px/1 var(--font-serif);
               letter-spacing: 0.08em; }
.article h2 { font: 500 24px/1.25 var(--font-serif);
              margin: 8px 0 16px; text-wrap: balance; }
.article p { font: 400 17px/1.7 var(--font-serif); max-width: 60ch; }
```

The number is small, ink-blue, letter-spaced. The heading is 24px medium-weight serif. The body is 17px/1.7. Sectioned numerically, the doc reads as a printed treatise.

### 7. Hairline section break (~120px wide, not full width)

```css
hr.hair { border: none; border-top: 1px solid var(--rule);
          width: 120px; margin: 56px 0; }
```

Short, left-aligned, hairline. Full-width `<hr>` reads as a web page; a 120px rule reads as a printed pause.

### 8. Tag chip (rare, one or two per page max)

```css
.tag { display: inline-block; background: var(--accent); color: var(--bg);
       padding: 3px 8px; font: 500 11px/1 var(--font-serif);
       letter-spacing: 0.1em; text-transform: uppercase; border-radius: 2px; }
```

Solid ink-blue tag with parchment-color text. Used for category labels ("CRAFT", "PRINCIPLE", "DRAFT"). One or two per page; more and the discipline collapses.

### 9. Colophon (last block on the page, italic, muted)

```css
.colophon { margin-top: 80px; padding-top: 24px;
            border-top: 1px solid var(--rule);
            font: italic 13px/1.6 var(--font-serif);
            color: var(--muted); }
```

"Set in Charter on parchment. Composed February 2026. For internal circulation." That kind of voice. One paragraph, last on the page.

---

## Concrete examples

### Example 1 — a product philosophy document "Principles"

Content: Ownware's nine founding principles, paraphrased and condensed. Format: numbered articles, italic byline at top, colophon at bottom.

- **Folio (top-right):** `OWNWARE · PRINCIPLES · VOL I`.
- **Kicker:** `DECLARATION`.
- **Title:** "Principles." 48px Charter 500, near-black.
- **Attribution:** "— *The founding team, February 2026*", italic muted.
- **Hairline break** (120px).
- **Article 01:** number kicker "01.", h2 "Reliability is the product.", body paragraph.
- **Article 02:** "02.", "Production means production.", body.
- **Article 03:** "03.", "Local-first is non-negotiable.", body.
- **Hairline break** (signals "and here are the harder ones").
- **Article 04:** "04.", "We push back when the job is too big.", body.
- **Article 05:** "05.", "We diagnose before defending.", body.
- **Articles 06–09:** same pattern.
- **Colophon:** "Set in Charter on parchment. Composed February 2026. For internal circulation among the founding team and the people we'd want to be."

Full HTML for the first two articles:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ownware — Principles, Vol I</title>
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+Pro:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#F5F4ED; --paper-2:#EFEEE5; --ink:#1F1D18; --muted:#6B665B;
            --rule:#D6D2C5; --accent:#1B365D; --grain:rgba(31,29,24,.025);
            --font-serif:"Charter","Source Serif Pro","Iowan Old Style",Georgia,serif; }
    body { margin:0;
           background:radial-gradient(circle at 50% 50%, transparent 0%, var(--grain) 100%), var(--bg);
           color:var(--ink); font:16px/1.55 var(--font-serif); text-wrap:pretty; }
    .page { position:relative; max-width:720px; margin:64px auto; padding:96px 80px;
            box-shadow:0 0 0 1px var(--rule); background:var(--bg); }
    .folio { position:absolute; top:48px; right:80px;
             font:400 12px/1 var(--font-serif); letter-spacing:.18em;
             color:var(--muted); text-transform:uppercase; }
    .kicker { color:var(--accent); font:500 12px/1 var(--font-serif);
              letter-spacing:.14em; text-transform:uppercase; }
    h1.title { font:500 48px/1.1 var(--font-serif); margin:16px 0 8px;
               text-wrap:balance; letter-spacing:-.01em; }
    .attribution { font-style:italic; font-size:16px; color:var(--muted); margin:24px 0 56px; }
    hr.hair { border:none; border-top:1px solid var(--rule); width:120px; margin:56px 0; }
    .article { margin:56px 0; }
    .article-num { color:var(--accent); font:500 14px/1 var(--font-serif); letter-spacing:.08em; }
    .article h2 { font:500 24px/1.25 var(--font-serif); margin:8px 0 16px; text-wrap:balance; }
    .article p { font:400 17px/1.7 var(--font-serif); max-width:60ch; }
    .colophon { margin-top:80px; padding-top:24px; border-top:1px solid var(--rule);
                font:italic 13px/1.6 var(--font-serif); color:var(--muted); }
    @media (max-width:760px) { .page { margin:0; padding:56px 24px; box-shadow:none; }
                                .folio { position:static; margin:0 0 32px; } }
  </style>
</head>
<body>
  <article class="page" data-cx-id="page">
    <span class="folio">Ownware · Principles · Vol I</span>
    <span class="kicker">Declaration</span>
    <h1 class="title">Principles.</h1>
    <p class="attribution">— <i>The founding team, February 2026.</i></p>
    <hr class="hair" />
    <section class="article">
      <span class="article-num">01.</span>
      <h2>Reliability is the product.</h2>
      <p>Reliability is not "tests pass." Reliability is a real user installing the thing
         on their laptop and it just working, for months. No silent failures. No spinners
         that never resolve. Every line we ship goes to production and a real human sees it.</p>
    </section>
    <section class="article">
      <span class="article-num">02.</span>
      <h2>Production means production.</h2>
      <p>No "TODO." No "fix later." No placeholder values that we secretly know aren't
         good enough. If we can't do something fully and cleanly, we do less.</p>
    </section>
    <!-- … articles 03–09 … -->
    <p class="colophon">Set in Charter on parchment. Composed February 2026.
       For internal circulation among the founding team and the people we'd want to be.</p>
  </article>
</body>
</html>
```

That's the canonical parchment doc. Same skeleton scales to 3 principles or 30.

### Example 2 — a letter / declaration variant

Content: A founder's letter on why the product exists. Same tokens, looser layout.

- **Folio:** `A LETTER · FEB 2026`.
- **Kicker:** `LETTER` (ink-blue chip).
- **Title:** "Why we built this." 42px Charter 500.
- **Date line:** "February 14, 2026" — italic, muted, after the title.
- **Body:** five paragraphs, left-aligned, 17px/1.7, paragraph spacing 1.5em.
- **Sign-off:** "— *Sam Cho*", italic right-aligned, 32px above the colophon.
- **Hairline 120px** above the sign-off.
- **Colophon:** "Hand-set in Charter. For anyone who needed to hear it."

Same tokens, no numbered articles — the letter form just uses flowing paragraphs with one short rule before the sign-off. The voice survives because the tokens carry it.

---

## Anti-patterns

- **Pure white background.** Breaks the printed-page illusion in one frame. Always `#F5F4ED` parchment.
- **Drop shadows on the page block.** A drop shadow turns the page into a web card. Use `box-shadow: 0 0 0 1px var(--rule)` (hairline ring) or nothing.
- **A second accent color.** No teal "for variety," no warm gold "for the tag chip." Ink-blue only. The constraint is the discipline.
- **Bold body or bold headings.** A serif at 700 on parchment reads as advertising. Weight 500 max for headings, 400 for body. Always.
- **Sans-serif anywhere.** This is a single-serif system. A sans on parchment breaks the voice in the moment it appears.
- **Full-width `<hr>` rules.** A horizontal rule that spans the column reads as a web divider. Hairlines are 120px wide, hand-placed, intentional.
- **Rounded cards or large radii.** Parchment doesn't round. Tag chips max 4px; everything else 0–2px.
- **Emoji in the body.** A single emoji breaks the printed feel. If the content has emoji, set them as Unicode glyph references styled to the page (rare) or remove them.
- **Numbered articles with web-style `<ol>` numbering.** The number kicker is a typographic move ("01."), not a list element. `<ol>` produces the wrong styling at all defaults — use sectioned `.article` blocks with manual numbering.
- **Multiple tag chips on one page.** One or two. Three reads as a CMS taxonomy widget, not a printed doc.
