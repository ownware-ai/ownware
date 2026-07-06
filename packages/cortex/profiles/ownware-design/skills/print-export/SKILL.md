---
name: print-export
description: 'HTML to PDF — @page rules, margins, bleeds, page-break-inside discipline, print stylesheet, CMYK gotchas, headless-Chrome generation. Use when the artifact has to be downloaded as a PDF or sent to a commercial printer — brochures, invoices, reports, posters, one-pagers. Pairs with /article-layout (long-form source content) and /pptx-export (slide deck export). Skip for screen-only artifacts and emails.'
trigger: /print-export
---

# Print Export — HTML that renders correctly on paper

## Overview

Print is the web with three new constraints: a fixed page size, no scroll, and CMYK at the press. Most modern CSS works in headless Chrome's print path; the bugs are in the seams — section breaks falling mid-paragraph, the saturated digital blue turning muddy on coated stock, a 1px hairline rule vanishing at 300dpi.

This skill is the recipe for shipping a PDF the user can hand to a printer or attach to an email. Pairs with `/article-layout` (long-form source) and `/pptx-export` (slide-deck export). Skip it for screen-only artifacts — print CSS adds weight you don't need.

---

## Critical Constraints — read these first, every time

1. **`@page` rules drive the canvas.** Page size (A4, Letter, Tabloid), margin, and bleed live in `@page`, not in body padding. The browser respects this; manual padding fights it.
2. **Page-break discipline at every section.** `page-break-inside: avoid` on cards, tables, figures. `page-break-after: always` on cover pages and the last page of a section. `page-break-before: avoid` on subheads so they don't strand at the bottom.
3. **300dpi minimum for raster.** Web images are typically 72dpi. Print at 72dpi looks pixelated on paper. Source images at 300dpi or use SVG. A 600px-wide screen image becomes ~2px wide at print scale — useless.
4. **CMYK shift: saturated digital colours become muddy.** RGB `#0066ff` (electric blue on screen) becomes a flat navy in CMYK. Design in RGB but pre-flight the saturated values; substitute slightly desaturated tones for the heaviest fills.
5. **Bleed is +3mm / +0.125in on every commercial print.** Any colour that should reach the edge of the page must extend 3mm past the trim. Printers cut into the bleed; without it, you get a white hairline at the edge.
6. **Headless Chrome is the production export path.** Puppeteer or Playwright's `page.pdf({ format, printBackground, margin })`. The agent writes the HTML; the user (or a build step) runs the export.

---

## Page sizes — real dimensions

| Format        | Dimensions (mm)   | Dimensions (in)   | Common use                     |
| ------------- | ----------------- | ----------------- | ------------------------------ |
| A4            | 210 × 297         | 8.27 × 11.69      | EU letter, reports, brochures  |
| Letter (US)   | 216 × 279         | 8.5 × 11          | US letter, invoices, one-pagers|
| Tabloid (US)  | 279 × 432         | 11 × 17           | Posters, large reports         |
| A3            | 297 × 420         | 11.69 × 16.54     | EU tabloid                     |
| A5            | 148 × 210         | 5.83 × 8.27       | Booklets, half-letter          |
| US Trade      | 152 × 229         | 6 × 9             | Trade paperback                |

Bleed adds 3mm (0.125in) per edge — A4 with bleed becomes 216 × 303mm.

---

## The print stylesheet — what every export file contains

```css
@page {
  size: A4;                    /* or "letter", "tabloid", "210mm 297mm" */
  margin: 18mm 16mm;           /* outer trim */
  marks: crop cross;           /* show crop marks in print preview (browser-dependent) */
}

/* Cover page: full-bleed background, no margin */
@page :first {
  margin: 0;
}

/* Recto pages (right side, odd) get the gutter on the left */
@page :right { margin-left: 22mm; margin-right: 14mm; }
@page :left  { margin-left: 14mm; margin-right: 22mm; }

@media print {
  html, body { background: white; color: black; }
  body { font-size: 11pt; line-height: 1.45; }

  /* Section discipline */
  section { page-break-inside: avoid; }
  h1, h2, h3 { page-break-after: avoid; }
  figure, table { page-break-inside: avoid; }

  /* Hide screen-only chrome */
  nav, .no-print, .screen-only { display: none !important; }

  /* Show URL after links for the print reader */
  a[href]:after { content: " (" attr(href) ")"; font-size: 9pt; color: #666; }
  a[href^="#"]:after, a[href^="javascript:"]:after { content: ""; }

  /* Force backgrounds (otherwise Chrome strips them in print) */
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
```

`pt` for body type. Margins in `mm`. The cover page gets `:first` with zero margin so a full-bleed colour reaches the edge.

---

## Page breaks — the surgical rules

```css
.cover            { page-break-after: always; }
.toc              { page-break-after: always; }
.chapter          { page-break-before: always; }
.section          { page-break-inside: avoid; }
.figure, .pull    { page-break-inside: avoid; }
h2, h3            { page-break-after: avoid; }     /* keep heading with its body */
p, li             { orphans: 3; widows: 3; }       /* 3 lines minimum at top or bottom */
```

Orphans = lines stranded at the bottom of a page. Widows = lines stranded at the top. 3 each is the typesetter's floor.

---

## CMYK pre-flight

When designing for commercial print:

- **Saturated digital blues** (`#0066ff`, `#1e90ff`) become muddy navy. Desaturate by 10–15%: `#2f6feb` → `#3c6ec9`.
- **Hot reds and oranges** (`#ff3030`, `#ff6b00`) print well. Safe.
- **Bright greens** (`#00cc66`) shift to deeper olive. Add 5% blue to keep the lift: `#1aa863`.
- **Pure black for body text:** use C0 M0 Y0 K100, not the four-colour "rich black" (C40 M30 Y30 K100) — small body text in rich black blurs slightly from press registration.
- **Rich black is fine for large fills** (full-bleed backgrounds, posters).

Provide the printer with PDF/X-1a or PDF/X-4 (ISO standards for press). Chrome's headless export is PDF/A-compatible; for press-grade output, run the PDF through Ghostscript or Acrobat's pre-flight.

---

## Concrete examples

### Example 1 — a 4-page brochure with cover, two content spreads, and back-cover

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Acme — Service Brochure</title>
  <style>
    :root {
      --fg: #1a1a1a; --muted: #4a4a4a; --accent: #c96442;
    }
    @page { size: A4; margin: 18mm 16mm; }
    @page :first { margin: 0; }

    body { margin: 0; font: 11pt/1.5 "Iowan Old Style", Georgia, serif; color: var(--fg); }

    .cover {
      page-break-after: always;
      height: 297mm; width: 210mm;
      background: var(--accent); color: white;
      display: grid; place-content: center; text-align: center;
      padding: 24mm;
    }
    .cover h1 { font-size: 48pt; line-height: 1.05; margin: 0; }
    .cover p  { font-size: 14pt; margin: 24pt 0 0; opacity: 0.85; }

    .chapter { page-break-before: always; }
    .chapter h2 { font-size: 28pt; margin: 0 0 18pt; page-break-after: avoid; }
    .chapter p  { margin: 0 0 12pt; }

    .feature-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 16pt;
      page-break-inside: avoid;
    }
    .feature { border: 0.5pt solid #ddd; padding: 12pt; page-break-inside: avoid; }

    .back-cover {
      page-break-before: always;
      height: 297mm; width: 210mm;
      background: var(--fg); color: white;
      display: grid; align-content: end; padding: 24mm;
    }

    @media print { * { -webkit-print-color-adjust: exact !important; } }
  </style>
</head>
<body>
  <section class="cover" data-cx-id="cover">
    <h1>Acme<br>Field&nbsp;Services</h1>
    <p>Annual brochure · 2026</p>
  </section>

  <section class="chapter" data-cx-id="services">
    <h2>What we do</h2>
    <p>Three lines of service across the United Kingdom, delivered by a roster of 240 field engineers.</p>
    <div class="feature-grid">
      <div class="feature"><strong>Maintenance.</strong> 24-hour response, contract or pay-as-you-go.</div>
      <div class="feature"><strong>Installation.</strong> Commercial and industrial — under 5,000 sq ft.</div>
      <div class="feature"><strong>Surveys.</strong> Same-week scheduling, written report in 48h.</div>
      <div class="feature"><strong>Compliance.</strong> Annual gas, electrical, and water audits.</div>
    </div>
  </section>

  <section class="chapter" data-cx-id="proof">
    <h2>Who we serve</h2>
    <p>Logos and references. (Body content goes here — page break before this chapter ensures it starts at the top of a fresh page.)</p>
  </section>

  <section class="back-cover" data-cx-id="back-cover">
    <p>Acme Field Services Ltd · 12 Mill Road, Cambridge CB1 2AB</p>
    <p>+44 1223 555 0100 · hello@acme.co.uk</p>
  </section>
</body>
</html>
```

Cover with zero margin (full-bleed accent). Chapters force `page-break-before`. Feature grid prevents internal breaks. Back cover lands on its own page.

### Example 2 — the headless-Chrome export script

```js
// export.mjs — run with: node export.mjs
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${process.cwd()}/brochure.html`, { waitUntil: "networkidle" });

await page.pdf({
  path: "brochure.pdf",
  format: "A4",
  printBackground: true,
  margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  preferCSSPageSize: true,    // honour the @page rule in the HTML
});

await browser.close();
console.log("→ brochure.pdf");
```

`preferCSSPageSize: true` is the load-bearing flag — without it, Playwright's `format: "A4"` overrides the HTML's `@page` margins. With it, the HTML drives the layout.

---

## Anti-patterns

- **`overflow: hidden` on the body.** Stop. Hides content that flows onto subsequent pages — the printer sees one page and stops.
- **Fixed pixel widths on layout.** Stop. Use `mm` or `in` so the layout maps to the physical page; pixels are a screen unit and shift between zoom levels.
- **72dpi raster on a print artifact.** Stop. Source SVG or 300dpi raster. A logo at 72dpi prints as a fuzzy block.
- **Skipping the `:first` page rule.** Stop. The cover wants zero margin for a full-bleed colour; the body wants 18mm. Use `@page :first` to differentiate.
- **Forgetting `print-color-adjust: exact`.** Stop. Chrome strips background colours by default in print to save ink. Force it on if your design depends on filled backgrounds.
- **Underline-styled links in body type.** Stop. On screen, blue underline is interactive. On paper, the URL is dead weight unless you also show it via `a:after { content: " (" attr(href) ")"; }`. Either show the URL or strip the link style.
- **Sending RGB-only files to a commercial printer.** Stop. Pre-flight to PDF/X or get the printer to run the conversion. Print houses charge you for converting at the press.
