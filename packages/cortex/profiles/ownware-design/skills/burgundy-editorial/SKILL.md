---
name: burgundy-editorial
description: 'Deep-wine editorial style for long-form essays — high-contrast serif display, cream paper, drop caps, asymmetric pull quotes. Use when the brief is "premium magazine essay", "manifesto", or "studio principles long-read". Layered on top of /article-layout. Skip for product landings (the burgundy reads precious) and skip for posts under 400 words (the affordances don''t earn).'
trigger: /burgundy-editorial
---

# Burgundy Editorial — wine, cream, and a steady serif voice

## Overview

This is the magazine voice. Wine-deep accent, cream paper, an Italian-style high-contrast serif for the display line, a humanist body that doesn't fight it. The whole piece reads like it was set in a quiet room. Pair with `/article-layout` for the long-form structural moves (drop cap, pull quote, ornament, footnotes) and `/artifact` for the file shape.

The point of the style is *restraint*. Burgundy used badly turns into a steakhouse menu. Burgundy used well — small accent, generous margins, one drop cap, one pull quote per movement — reads like Monocle or The Gentlewoman.

---

## Critical Constraints — read these first, every time

1. **One accent, used sparingly.** `--accent: #5C1A1B` (deep wine) appears in the drop cap, the pull-quote left rule, the link underline, and *nowhere else*. Section dividers, byline, captions: `--muted`. The accent must remain rare or it stops carrying weight.
2. **Cream background, never white.** `--bg: #F4E9D9` (warm cream). White on this layout reads cold and breaks the magazine illusion in a single repaint.
3. **Italian high-contrast serif for display only.** Body stays in a calm humanist serif. Mixing both at body size makes the page busy.
4. **One drop cap, opening paragraph only.** Same rule as `/article-layout`. Decoration that repeats stops being decoration.
5. **Pull quote breaks the column to the left, not the right.** The page reads top-to-bottom on the right margin; the pull punches out left for asymmetry. Right-side pulls feel pinned, wrong-handed.
6. **Generous side margins.** Body column `max-width: 60ch` (~640px at 19px / 1.7). Page padding ≥ 6vw on desktop. The white space is part of the voice.

---

## The token block (paste verbatim into `:root`)

```css
:root {
  --bg: #F4E9D9;             /* warm cream */
  --surface: #FBF4E5;        /* one step lighter, for sidebars */
  --fg: #1F1A14;             /* near-black with warm undertone, never #000 */
  --muted: #6F665A;          /* warm gray for byline, captions */
  --border: #E0D4BD;         /* hairline rule color */
  --accent: #5C1A1B;         /* deep wine — the load-bearing color */
  --accent-2: #8B2C2E;       /* lighter wine for hover / secondary mark */
  --accent-pale: #C58787;    /* dusty rose — for tag chips, not body type */
  --radius: 0;               /* magazine pages don't round */
  --font-display: "Playfair Display", "Bodoni Moda", "Didot", "Times New Roman", serif;
  --font-body: "Iowan Old Style", "Charter", "Source Serif Pro", "Georgia", serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
body { font: 19px/1.7 var(--font-body); background: var(--bg); color: var(--fg); text-wrap: pretty; }
.body { max-width: 60ch; margin: 0 auto; padding: 0 6vw; }
```

That block is the whole palette. Cream, wine, ink, two serifs. No other colors invited.

---

## Rubric — the burgundy affordances

### Display headline

`font-family: var(--font-display); font-size: clamp(40px, 6vw, 72px); line-height: 1.02; letter-spacing: -0.015em; text-wrap: balance; color: var(--fg);` — Italian high-contrast serif at large size leans on the thick/thin contrast. Tighter letter-spacing keeps the thicks reading as one mark.

### Drop cap (opening paragraph only)

```css
.body > p.opening::first-letter {
  float: left;
  font-family: var(--font-display);
  font-size: 6.5em;          /* about 5 baseline lines */
  line-height: 0.82;
  margin: 0.04em 0.1em 0 0;
  font-weight: 700;
  color: var(--accent);
}
```

The drop cap is the only place the accent breathes at scale. Keep it.

### Pull quote (left-punched, asymmetric)

```css
.pull {
  margin: 56px -10vw 56px 0;     /* punches out the LEFT margin only */
  padding: 8px 0 8px 28px;
  border-left: 3px solid var(--accent);
  font-family: var(--font-display);
  font-size: clamp(26px, 3.2vw, 36px);
  font-style: italic;
  line-height: 1.2;
  text-wrap: balance;
  color: var(--fg);
}
@media (max-width: 760px) { .pull { margin: 32px 0; } }
```

Italic display at oversized scale, left-punched out of the body column. The italic distinguishes the pull from any nearby h2.

### Section ornament (between movements only)

`hr.ornament::before { content: "❦"; color: var(--accent); font-size: 18px; }` centered, 48px above and below. One ornament between major movements (Act II → Act III). Not between every h2.

### Byline + dateline

One line, mid-dot separators, `font-size: 14px; color: var(--muted); letter-spacing: 0.02em;`. Author name in italic. No underline.

### Tag chip (kicker above title)

`background: var(--accent-pale); color: var(--accent); padding: 4px 10px; font: 11px/1 var(--font-body); letter-spacing: 0.12em; text-transform: uppercase;`. This is the only place dusty rose appears — a single chip at the top, naming the section ("ESSAY", "FIELD NOTES", "STUDIO LETTER").

---

## Concrete examples

### Example 1 — a 1200-word studio essay "On the patience of typography"

- **Kicker chip:** `ESSAY · CRAFT` in dusty rose chip.
- **Title:** "On the patience of typography." — 64px Playfair Display, balanced wrap, 40px below.
- **Byline:** "By *Lena Rivas* · February 14, 2026 · 9 min read", muted, mid-dots, author italic.
- **Lede:** 24px italic standfirst, one paragraph: "Type doesn't ask for your attention. It earns it by being there, calmly, when the eye returns."
- **Body opens:** drop cap on "T" of the first paragraph, wine-colored, five lines deep. Body in Iowan Old Style 19px / 1.7.
- **First h2 at ~300 words:** 32px Playfair, sentence-case, 56px above / 16px below.
- **Pull quote at ~600 words** (left-punched, italic): "A page composed in haste reads as though the writer was somewhere else."
- **Ornament at ~900 words:** centered `❦` between the second and third movement.
- **Footnote at ~1000 words:** `<sup>1</sup>` after a contentious claim; entry at bottom with `↩` back-link.
- **Related reading footer:** two cards, equal width, plain titles in display serif.
- **Colophon:** "Set in Playfair Display & Iowan Old Style. Cream paper. February, 2026."

That's the full kit, one essay, paste-ready.

### Example 2 — minimum file skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>On the patience of typography — Foundry Letter</title>
  <style>
    /* TOKENS — paste the block from above */
    :root { --bg:#F4E9D9; --fg:#1F1A14; --accent:#5C1A1B; --accent-pale:#C58787; --muted:#6F665A; --border:#E0D4BD;
            --font-display:"Playfair Display",serif; --font-body:"Iowan Old Style",Georgia,serif; }
    body { margin:0; background:var(--bg); color:var(--fg); font:19px/1.7 var(--font-body); }
    .body { max-width:60ch; margin:0 auto; padding:80px 6vw; }
    .kicker { display:inline-block; background:var(--accent-pale); color:var(--accent);
              padding:4px 10px; font:11px/1 var(--font-body); letter-spacing:.12em; text-transform:uppercase; }
    h1 { font-family:var(--font-display); font-size:clamp(40px,6vw,64px); line-height:1.02;
         letter-spacing:-.015em; text-wrap:balance; margin:24px 0 8px; }
    .byline { font-size:14px; color:var(--muted); margin:0 0 32px; }
    .lede { font-size:24px; line-height:1.5; font-style:italic; margin:0 0 40px; }
    .body > p.opening::first-letter { float:left; font-family:var(--font-display); font-size:6.5em;
         line-height:.82; margin:.04em .1em 0 0; font-weight:700; color:var(--accent); }
    h2 { font-family:var(--font-display); font-size:32px; margin:56px 0 16px; text-wrap:balance; }
    .pull { margin:56px -10vw 56px 0; padding:8px 0 8px 28px; border-left:3px solid var(--accent);
            font-family:var(--font-display); font-style:italic; font-size:clamp(26px,3.2vw,36px); line-height:1.2; }
    hr.ornament { border:none; text-align:center; margin:48px 0; }
    hr.ornament::before { content:"❦"; color:var(--accent); font-size:18px; }
    @media (max-width:760px) { .pull { margin:32px 0; } }
  </style>
</head>
<body>
  <article class="body" data-cx-id="essay">
    <span class="kicker">Essay · Craft</span>
    <h1>On the patience of typography.</h1>
    <p class="byline">By <i>Lena Rivas</i> · February 14, 2026 · 9 min read</p>
    <p class="lede">Type doesn't ask for your attention. It earns it by being there, calmly, when the eye returns.</p>
    <p class="opening">The page is not a stage…</p>
    <!-- … rest of the essay … -->
  </article>
</body>
</html>
```

That skeleton is the burgundy voice at its smallest stable shape. Add sections, pulls, and footnotes inside `.body` per `/article-layout`.

---

## Anti-patterns

- **Multiple accent colors.** Adding a gold or a teal "to break it up" kills the voice. One wine. That's the discipline.
- **White background for "readability."** Cream IS the readability move. White on wine reads like a wedding invitation.
- **Body type in the display serif.** Playfair at 19px is exhausting. Reserve the high-contrast face for display sizes (≥ 28px).
- **Drop cap on every section.** One. Opening paragraph only. Repeated drop caps are not magazine — they're a parody of magazine.
- **Right-punched pull quotes.** Breaks the page rhythm because the right margin is the eye's natural return. Left-punched only.
- **Sans-serif anywhere.** Burgundy editorial is a two-serif system. The moment a sans appears, the voice cracks.
- **Heavy use of the dusty rose.** It's a tag-chip color and a hover tint. Not a body color, not a panel background.
