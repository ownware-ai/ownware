---
name: deck
description: The slide deck framework. Use when the artifact is a presentation — pitch deck, weekly report, sales deck, conference talk, internal proposal. Defines the 1920×1080 canvas, scale-to-fit, keyboard nav, page counter, position-restore, and print stylesheet for PDF export. Decks are still ONE HTML file with N slide sections — never N separate files.
trigger: /deck
---

# Deck — slides as sections in one file

## Overview

A deck is a self-contained HTML file with N slides as `<section class="slide">` blocks. Twenty slides becomes one twenty-section document. The user navigates with arrow keys, page-down, or click; the file scales to any viewport; the print stylesheet stitches a clean PDF.

The framework below is *fixed*. Copy it into every deck verbatim, then fill in the slide content. Do not invent your own scaling, nav, or print logic — three previous attempts at "I'll just write a quick scroll-snap" produced decks that don't print to PDF correctly.

---

## Critical Constraints — read these first, every time

1. **One file.** Not one file per slide. Twenty slides = twenty `<section>` blocks inside `index.html`.
2. **1920×1080 canvas.** Each slide is laid out at this size in CSS units. JS scales the deck to the viewport via CSS transform, preserving aspect.
3. **Slide numbering is 1-indexed.** When the user says "slide 3", they mean the third `<section class="slide">`, not the fourth.
4. **Tag every slide with `data-screen-label="<num> <Short title>"`.** This is how the user references slides. `data-screen-label="01 Cover"`, `data-screen-label="07 Market sizing"`. Match the slide number.
5. **Persist current position to localStorage.** A refresh must land the user on the same slide.
6. **Print stylesheet mandatory.** `@media print` flattens slides to one-per-page so PDF export works.
7. **Slide text never below 24px.** A 1920×1080 canvas viewed on a projector or shared screen renders smaller text unreadable.

---

## The fixed framework — copy verbatim into every deck

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{Deck title}</title>
  <style>
    :root {
      /* Tokens from the chosen direction */
      --bg: …;  --surface: …;  --fg: …;  --muted: …;  --accent: …;
      --font-display: …; --font-body: …;
    }

    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: var(--bg); color: var(--fg);
      font-family: var(--font-body); font-size: 18px; line-height: 1.5;
      overflow: hidden;
    }

    /* Each slide is a 1920×1080 canvas */
    .slide {
      width: 1920px; height: 1080px;
      padding: 96px 128px;
      display: none;
      flex-direction: column;
      page-break-after: always;
    }
    .slide.active { display: flex; }
    .slide h1 { font: 600 96px/1.05 var(--font-display); letter-spacing: -0.02em; margin: 0 0 32px; text-wrap: balance; }
    .slide h2 { font: 600 56px/1.1  var(--font-display); letter-spacing: -0.015em; margin: 0 0 24px; text-wrap: balance; }
    .slide p  { font-size: 28px; line-height: 1.4; margin: 0 0 24px; max-width: 1200px; }

    /* The viewport scales the slide via transform */
    .deck-wrap {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .deck-stage {
      transform-origin: center center;
      transition: transform 80ms linear;
    }

    /* Counter and nav */
    .deck-counter {
      position: fixed; bottom: 16px; right: 20px;
      font: 500 14px var(--font-body); color: var(--muted);
      z-index: 10;
    }

    /* Print → one slide per page, no transform */
    @media print {
      html, body { overflow: visible; background: #fff; }
      .deck-wrap { position: static; display: block; }
      .deck-stage { transform: none !important; }
      .slide { display: flex !important; page-break-after: always; box-shadow: none; }
      .deck-counter { display: none; }
    }
  </style>
</head>
<body>
  <div class="deck-wrap">
    <div class="deck-stage" id="deck-stage">
      <section class="slide active" data-screen-label="01 Cover" data-od-id="slide-1-cover">…</section>
      <section class="slide"        data-screen-label="02 Problem" data-od-id="slide-2-problem">…</section>
      <section class="slide"        data-screen-label="03 Market" data-od-id="slide-3-market">…</section>
      <!-- … remaining slides … -->
    </div>
  </div>
  <div class="deck-counter" id="deck-counter">1 / N</div>

  <script>
    (function () {
      const slides = Array.from(document.querySelectorAll('.slide'));
      const stage = document.getElementById('deck-stage');
      const counter = document.getElementById('deck-counter');
      const KEY = 'deck:position';
      let idx = Math.max(0, Math.min(slides.length - 1, parseInt(localStorage.getItem(KEY) || '0', 10)));

      function show(i) {
        idx = Math.max(0, Math.min(slides.length - 1, i));
        slides.forEach((s, n) => s.classList.toggle('active', n === idx));
        counter.textContent = (idx + 1) + ' / ' + slides.length;
        localStorage.setItem(KEY, String(idx));
      }

      function fit() {
        const sw = 1920, sh = 1080;
        const vw = window.innerWidth, vh = window.innerHeight;
        const scale = Math.min(vw / sw, vh / sh);
        stage.style.transform = 'scale(' + scale + ')';
        stage.style.width = sw + 'px';
        stage.style.height = sh + 'px';
      }

      window.addEventListener('resize', fit);
      window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { show(idx + 1); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { show(idx - 1); e.preventDefault(); }
        else if (e.key === 'Home') { show(0); e.preventDefault(); }
        else if (e.key === 'End') { show(slides.length - 1); e.preventDefault(); }
      });
      document.addEventListener('click', (e) => {
        if (e.target.closest('a, button, input, select, textarea')) return;
        show(idx + 1);
      });

      fit();
      show(idx);
    })();
  </script>
</body>
</html>
```

That's the skeleton. Copy it verbatim — do not "improve" the scaling math, the keyboard handler, or the localStorage key. They have all been chosen against print-to-PDF and refresh-position requirements.

---

## Per-slide structure

Each slide has its own `data-od-id` for surgical edits. Inside a slide:

- **Cover slide** — one giant headline, deck date, author. Use `<h1>` at 96–140px.
- **Section divider** — short label, number, breathing space. Useful between chapters in long decks.
- **Content slide** — headline (`<h2>` at 56px), one to three short paragraphs (`<p>` at 28px), optional inline `<svg>` chart or image placeholder.
- **Comparison slide** — two or three columns side by side. Each column has its own heading.
- **Data slide** — large numbers (96–160px) with small captions. Few words per number.
- **Quote slide** — pulled quote at 56–80px, attribution at 28px. Centered. Generous margins.
- **Closing slide** — call to action, contact, thanks. Single primary CTA.

Avoid 10-bullet slides. If you find yourself writing eight bullets, the content is two slides, not one.

---

## Naming slides for the user

Every slide carries `data-screen-label="<num> <Short title>"`. The number must match the actual position (one-indexed). The title is 1–4 words.

This is how the user references slides: "make slide 7 use a stepped chart instead of polyline." You find `data-screen-label="07 …"` (or `data-od-id="slide-7-…"`), edit between its tags, leave everything else.

If the user reorders slides ("move the market slide before problem"), update both the position and the `data-screen-label` numbers. The numbers are not decorative — they're how the deck and the user stay in sync.

---

## Print and export

The framework's `@media print` block above is the entire reason decks stay one HTML file. The user prints from the browser (Cmd-P / Ctrl-P), picks "Save as PDF," and gets one slide per page at the right aspect ratio. Do not advise the user to use a separate PPTX export route — printing is the deck's export path.

If the user explicitly wants PPTX, that's a separate tool conversation (`unoconv`, `marp`, etc.). Mention it; don't implement it in the artifact.

---

## What decks DON'T do

- **Don't add a navigation sidebar by default.** It eats slide real estate. If the user explicitly wants a thumbnail rail, add it as a hidden panel toggled by `?` key.
- **Don't animate slide transitions by default.** Hard cuts are fast and don't make the reader wait. Add a fade only if the user asks.
- **Don't add a "speaker notes" feature** unless the user asks. Speaker notes change the file structure significantly; opt-in only.
- **Don't try to be Reveal.js or PowerPoint.** A clean static deck with keyboard nav and a print stylesheet beats a half-built JS framework every time.
