---
name: poster-design
description: Single-image poster artifact — event, launch, recruiting, gig, conference, social-share. One dominant focal element, tight type hierarchy, exact pixel dimensions for print or screen. Use when the brief is "make a poster", "event flyer", "launch graphic", "social share card", "conference poster". Skip for multi-page brand sheets (use brand-identity), for landing pages (use artifact + web-guidelines), or for slide decks (use deck).
trigger: /poster-design
---

# Poster Design — one image, one idea, one focal point

## Overview

A poster is not a landing page squished to portrait. It is a single composition read at distance, then up close, in that order. The discipline is brutal: one dominant element occupies 50–70% of the canvas, one headline holds the eye in five words or fewer, and everything else is sized down to confirm-not-compete. This skill ships the poster as a single self-contained HTML file at exact poster dimensions, ready for screenshot-to-print or social export.

For interior polish on the type and the copy itself, lean on `/copy-refiner`. This skill owns the LAYOUT and the focal hierarchy.

---

## Critical Constraints — read these first, every time

1. **Pick the size first, before anything else.** The canvas dimensions decide every type size below. Three defaults:
   - **A2 print** — 594×420mm @ 150 DPI = 3508×2480px (or A3 at 297×420mm = 1754×2480px for smaller display posters).
   - **US Letter print** — 8.5×11in @ 150 DPI = 1275×1650px.
   - **Square social** — 1080×1080px (Instagram feed / LinkedIn).
   - **Portrait social / story** — 1080×1620px (Instagram story, TikTok cover, phone share).
2. **One dominant focal element occupies 50–70% of the canvas.** A photograph, a typographic display word, a geometric mark, a single illustration. Two equal-weight elements means no focal point, means the poster failed at distance.
3. **Headline ≤ 8 words.** Posters are read in two seconds at six feet. Eight words is the upper bound; four is better. Anything longer belongs on a flyer or a landing page.
4. **At most three typographic levels.** Headline, secondary, details. A fourth level (eyebrow + headline + subhead + body + details) reads as visual noise from across a room.
5. **High-contrast type-over-image discipline.** When text sits on imagery, force contrast with one of three patterns: (a) semi-transparent black panel behind the text (40–60% opacity), (b) a heavy `text-shadow` (`0 2px 16px rgba(0,0,0,0.6)`), or (c) a solid color block underneath the text. Never plain text over a busy photo.
6. **The poster is one HTML file at exact pixel dimensions.** Same file-shape discipline as `/artifact`: `:root` tokens, inline `<style>`, `data-cx-id` on every region. The `<body>` or a `.poster` wrapper carries `width: 1080px; height: 1620px;` (or the chosen dimensions) so screenshots come out exact.

---

## Layout patterns — the four shapes that work

### 1. The Single-Word Hero

Display headline takes 60% of the canvas vertical. Tracked tight (`letter-spacing: -0.04em`), 240–400px tall on a 1080px-wide canvas. Subhead and details sit at the bottom 25%. Example: SUNDOWN over a dusk image; CHANGELOG on a brand sheet; HIRING on a recruiting poster.

### 2. The Quadrant Frame

Headline pinned to one corner (top-left or bottom-right), accent block opposite, content negative-spaced through the middle. Used by Swiss-modernist tradition and most music gig posters. Best when the content is "event name + date + venue" and the headline is a single energetic word.

### 3. The Type-On-Photograph

Full-bleed photograph as background, text panel on the lower third (or upper third) over a semi-transparent black scrim (`background: rgba(0,0,0,0.55)`) for legibility. Headline 96–144px, details 24–32px below. Used by film posters, conference posters, travel.

### 4. The Centered Mark

A single geometric shape (circle, square, glyph) dead-centered, occupying 40–50% of canvas. Headline above or below it, details at the bottom. Used by minimalist gallery posters, lecture series, anniversaries.

---

## Type scale — exact numbers per canvas size

For a 1080×1620 portrait social poster:

| Role          | Size       | Weight    | Line-height | Tracking      |
|---------------|------------|-----------|-------------|---------------|
| Headline      | 144–240px  | 700–900   | 0.95        | -0.04em       |
| Subhead       | 36–48px    | 400–500   | 1.2         | normal        |
| Body / details| 20–28px    | 400       | 1.45        | normal        |
| Caption / footer | 14–18px | 400       | 1.4         | +0.05em (caps)|

For 3508×2480 (A2 print at 150 DPI) — multiply roughly 3.2×: headline 480–800px, subhead 110–150px, body 60–80px. The relationships stay; only the absolute numbers scale.

---

## File shape — paste-ready skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{Poster title}</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --fg: #f4f0e6;
      --accent: #ff4d00;
      --muted: rgba(244,240,230,0.65);
      --font-display: "Inter", "Helvetica Neue", Arial, sans-serif;
      --font-body: "Inter", "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1a1a; padding: 24px; display: grid; place-items: center; min-height: 100vh; font-family: var(--font-body); }
    .poster {
      width: 1080px;
      height: 1620px;
      background: var(--bg);
      color: var(--fg);
      position: relative;
      overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
    }
    .focal {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 65%;
      background: linear-gradient(135deg, #ff4d00 0%, #8b0000 100%);
    }
    .headline {
      position: absolute;
      bottom: 28%;
      left: 60px; right: 60px;
      font-family: var(--font-display);
      font-size: 200px;
      font-weight: 900;
      line-height: 0.92;
      letter-spacing: -0.04em;
      text-wrap: balance;
    }
    .subhead {
      position: absolute;
      bottom: 18%;
      left: 60px; right: 60px;
      font-size: 36px;
      color: var(--muted);
      line-height: 1.3;
    }
    .details {
      position: absolute;
      bottom: 60px;
      left: 60px; right: 60px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      font-size: 22px;
      color: var(--muted);
    }
    .details .when { font-variant-numeric: tabular-nums; }
    .footer-mark {
      font-size: 14px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
    }
  </style>
</head>
<body>
  <section class="poster" data-cx-id="poster">
    <div class="focal" data-cx-id="focal"></div>
    <h1 class="headline" data-cx-id="headline">SUNDOWN</h1>
    <p class="subhead" data-cx-id="subhead">An evening of live ambient + analog video, on the rooftop.</p>
    <div class="details" data-cx-id="details">
      <div>
        <div class="when">FRI · 28 JUN · 8PM</div>
        <div>The Mast · 14 Knot St, Brooklyn</div>
      </div>
      <div class="footer-mark">FIELD RECORDINGS — 24</div>
    </div>
  </section>
</body>
</html>
```

Three text levels, one dominant focal block, exact 1080×1620 canvas. That's the whole composition.

---

## Concrete examples

### Example 1 — A2 conference poster (3508×2480px print)

Brief: a one-day AI infrastructure conference. Single venue, three keynote speakers, date.

- **Direction:** Tech Utility direction, dark canvas, monospace numerals.
- **Focal:** a single oversized number `'26` (year) occupying the top half, in display sans 1200px, hairline weight. Single accent line under it.
- **Headline:** `AI INFRA` in 320px display, weight 800, set on the left edge with right ragged.
- **Subhead:** `One day · Three keynotes · Brooklyn Navy Yard · September 18` — 96px, regular, line-height 1.3.
- **Details block:** speaker names + affiliations in a 64px monospace list, bottom-left. Ticket URL bottom-right, 56px in accent color.
- **Footer mark:** `INFRA / 26 / NAVY YARD` in 36px tracked caps along the bottom edge.
- **CSS:** `.poster { width: 3508px; height: 2480px; background: #0d1117; color: #e6edf3; }` plus the accent `#58a6ff`.

### Example 2 — 1080×1080 Instagram launch post

Brief: launch graphic for a new espresso bar.

- **Direction:** Warm Soft direction, terracotta + cream.
- **Focal:** a single illustrated coffee cup, centered, occupying 45% of the canvas. Hand-drawn-feeling SVG.
- **Headline:** `OPEN.` in 200px display serif, dead-centered below the cup, weight 700.
- **Subhead:** `7am — Friday — 142 Bedford` in 32px sans, mid-dot separators, muted.
- **Footer mark:** wordmark `BARN ESPRESSO` in 18px caps tracked +0.12em, bottom-center.
- **CSS:** `.poster { width: 1080px; height: 1080px; background: #fdf9f3; color: #2a1f17; }` accent `#c96442`.

That's the whole post: cup, OPEN., date+address, wordmark. Four elements. Reads in one second.

### Example 3 — Recruiting poster, 1080×1620 portrait

Brief: hiring poster for a senior product engineer role at a small B2B SaaS.

- **Direction:** Modern Minimal, cobalt accent.
- **Headline:** `WE'RE HIRING ENGINEERS WHO ALSO SKETCH.` — 88px (longer headline, smaller size, deliberate).
- **Subhead:** `Senior product engineer · remote · base $190k + equity` — 30px, muted, mid-dot separators.
- **Focal block:** a 50%-height block of pencil-sketch product UI screenshots in a 3×4 grid below the headline, slightly tilted, monochrome.
- **Details:** `careers.acme.co/eng-2026` in 36px accent bottom-left; `apply by Aug 31` in 24px muted bottom-right.
- **Footer mark:** wordmark + year top-left, small caps.

That's three regions, one focal proof block, one headline that breaks the "≤8 words" rule deliberately because the joke (engineers who sketch) carries the recruitment angle.

---

## Anti-patterns

- **A wall of bullets.** If the poster has more than three short lines of body copy, it's a flyer, not a poster. Cut, or switch to a flyer + QR-code link to a landing page.
- **Tiny logo top-right, large logo top-left, and a third logo in the footer.** One brand mark per poster, one location. Three logos read as "designed by committee."
- **Stock photo with text floated over it, no contrast layer.** The text disappears at thumbnail size. Always add a semi-transparent panel, a text-shadow, or a solid block.
- **Headline + subhead + tagline + standfirst + body + caption.** Six levels. Stop. Three is the cap. If the brief needs all six, the brief is for a landing page, not a poster.
- **Gradient text over a gradient background.** Both fight for the eye; neither wins. Solid text on gradient OR gradient text on solid — never both.
- **Headline in the dead center with everything else margined around it equally.** That's a placeholder, not a composition. Push the headline off-center, anchor it to one edge, let negative space carry the rest.
- **Forgetting the canvas dimensions and exporting at the wrong size.** Always set `.poster { width: …px; height: …px; }` explicitly. The user screenshots that element; if you didn't lock the size, the export is a guess.
