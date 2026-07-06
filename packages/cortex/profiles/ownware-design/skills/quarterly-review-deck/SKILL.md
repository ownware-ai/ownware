---
name: quarterly-review-deck
description: 'Quarterly business review deck — cover with headline metric, 3–5 KPI/trend slides, wins (3 bulleted), misses (3 honest), next-quarter bets (3). Retro-modern brand: monospace headers + serif body, blue-orange-cream palette. Use for board reviews, internal QBRs, investor updates, team all-hands recaps. Skip for sales decks (use /deck) or operational dashboards (use /report-builder).'
trigger: /quarterly-review-deck
---

# Quarterly Review Deck — retro-modern QBR structure

## Overview

QBRs follow a fixed cadence: open with the quarter's headline number, ground it in 3–5 KPIs, name 3 wins, name 3 misses honestly, then 3 bets for next quarter. This skill ships that exact 8-slide structure on the `/deck` framework with a retro-modern brand: monospace section labels, serif body, blue + orange + cream palette.

The honesty in the misses section is the load-bearing move. A QBR that hides what didn't work reads as a brochure; the value lives in the misses slide and the bets that respond to it.

---

## Critical Constraints

1. **8 slides, in this order.** Cover → KPI 1 → KPI 2 → KPI 3 (optional KPI 4–5) → Wins → Misses → Next Quarter → Thanks/Q&A. The order isn't decorative; it's the QBR contract. Deviating loses the audience.
2. **Brand: retro-modern.** Cream paper `#f4f0e6`, ink `#0a1428`, electric blue `#1d4ed8`, hot orange `#ea580c`. Headers in monospace (`JetBrains Mono`, `IBM Plex Mono`, `Menlo`), body in serif (`Fraunces`, `Iowan Old Style`, Georgia). The mono/serif split is the signature; don't swap to sans.
3. **Headline metric on the cover is ONE number.** ARR, revenue, MAU, retention — pick the one that defines the quarter. Show it at 320px. No second metric on the cover.
4. **KPI slide = tile + chart + 2-line context.** Big number top-left (160px), small trend chart (inline SVG) top-right, 2-line plain-English context below. No "synergistic alignment" — the context names the cause.
5. **Wins and misses are EXACTLY 3 each.** Not 5 wins and 2 misses. Not 7 wins. The symmetry forces honesty. If you can't name 3 misses, the quarter wasn't honestly reviewed.
6. **Misses lead with the verb, not the excuse.** `Shipped Pricing Page 6 weeks late — focus drift in October.` Not `Despite challenging headwinds, the Pricing Page launch slipped slightly.` The audience knows the difference.
7. **Bets are 3, named with owners and acceptance criteria.** `Launch self-serve onboarding by Aug 31 — owner: Priya — done when 30% of new signups complete without support.` Vague bets stay vague.
8. **Built on `/deck` framework.** 1920×1080 canvas, keyboard nav, print-to-PDF stylesheet. This skill doesn't reinvent the canvas; it specifies the brand and slide-by-slide composition.

---

## The 8-slide spec

### Slide 1 — Cover

- **Top-left chip:** `Q3 · 2026` in mono, 32px, +0.16em uppercase tracking.
- **Headline metric:** the single number, 320px, weight 700, mono. Color: ink.
- **Metric caption:** `ARR ANNUALIZED · +38% Q-OVER-Q` in 36px mono, +0.12em.
- **Sub-deck title:** `Quarterly Review — Operations` in 48px serif italic, color muted.
- **Footer:** `Prepared by leadership · For internal review` in 18px mono.

### Slides 2–4 (or 2–6 if 5 KPIs) — KPI tiles

Each KPI slide carries:

- **KPI label** (top-left, mono, 28px, +0.16em uppercase): `NET REVENUE RETENTION`.
- **KPI number** (160px, mono weight 700): `118%`.
- **Trend chart** (top-right, inline SVG, 6-quarter sparkline using `<polyline>`, stroke 3px in electric blue).
- **Context** (centered, 2 lines, 36px serif): `Up from 109% last quarter. Two enterprise upgrades carried 6 points; mid-market still flat.`
- **Footer rule:** thin orange `2px` line, 96px from bottom.

### Slide 5 (or 6) — Wins

- **Title:** `WINS · Q3` in 80px mono.
- **Three rows.** Each row: orange `3px` left border + headline (48px serif weight 600) + 1-line context (24px serif italic muted).

Example rows:

1. **Shipped the AI Assistant on July 14.** 12 weeks ahead of plan; 1,800 paid activations in first month.
2. **Hired 2 senior ICs (eng + design).** Both started before September; one already shipped to prod.
3. **Cut p95 latency 410ms → 180ms.** July infra rewrite paid for itself by month 2.

### Slide 6 (or 7) — Misses (the honest one)

Same shape as wins, but with the electric-blue `3px` border. Three rows, honest verbs.

1. **Shipped Pricing Page 6 weeks late.** Focus drift in October; the team chose to wait on the assistant launch.
2. **NPS dipped from 52 → 44 in August.** Two outages and a billing-page regression — root cause was insufficient release gating.
3. **Self-serve activation plateaued at 22%.** Funnel work moved from H1 plan into H2 and didn't restart.

### Slide 7 (or 8) — Next quarter

- **Title:** `BETS · Q4` in 80px mono.
- **Three bets.** Each: orange chip `BET 01`, then headline (48px serif), then owner + acceptance criteria (24px mono).

1. **`BET 01` · Launch self-serve onboarding.** owner: Priya · done when 30% of new signups complete without support.
2. **`BET 02` · Restore NPS to ≥ 50.** owner: Jonas · done when 30-day rolling NPS is 50 or higher across mid-market segment.
3. **`BET 03` · Close 5 enterprise deals from existing pipeline.** owner: Maya · done when 5 signed contracts > $50k ARR each.

### Slide 8 — Thanks / Q&A

- **Title:** `Thanks. Questions?` in 120px serif italic.
- **Contact strip:** team handles + meeting link in 24px mono, muted.
- **Footer:** mono signature `Q3 2026 review · prepared 26 May · for executive review`.

---

## Tokens — paste-ready

```css
:root {
  --bg: #f4f0e6;
  --surface: #fffaf2;
  --ink: #0a1428;
  --muted: #5a6478;
  --border: #d5cdb8;
  --blue: #1d4ed8;             /* signal blue — wins lines, charts */
  --orange: #ea580c;            /* signal orange — KPI accents, bet chips */
  --font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
  --font-mono: "JetBrains Mono", "IBM Plex Mono", Menlo, ui-monospace, monospace;
  --font-body: "Fraunces", Georgia, serif;
}
```

---

## Concrete example — the cover slide HTML

```html
<section class="slide active" data-cx-id="slide-1-cover" data-screen-label="01 Cover">
  <div style="font:600 32px var(--font-mono); letter-spacing:0.16em; text-transform:uppercase;
              color:var(--muted);">Q3 · 2026</div>

  <div style="margin-top:80px; font:700 320px/0.9 var(--font-mono); letter-spacing:-0.04em;
              color:var(--ink); font-variant-numeric:tabular-nums;">
    $4.2M
  </div>

  <div style="margin-top:24px; font:600 36px var(--font-mono); letter-spacing:0.12em;
              text-transform:uppercase; color:var(--orange);">
    ARR annualized · +38% Q-over-Q
  </div>

  <div style="margin-top:120px; font:italic 400 48px var(--font-display);
              color:var(--muted); max-width:1200px;">
    Quarterly Review — Operations
  </div>

  <div style="position:absolute; bottom:96px; left:128px; right:128px;
              display:flex; justify-content:space-between;
              font:500 18px var(--font-mono); color:var(--muted); letter-spacing:0.08em;">
    <span>Prepared by leadership</span>
    <span>For internal review · 26 May 2026</span>
  </div>
</section>
```

That's the cover. The remaining 7 slides follow the same `data-cx-id` + token pattern. Each slide carries `data-screen-label="<NN> <Short title>"` so the user can navigate by number ("jump to slide 06 — misses").

### A KPI slide chart (inline SVG sparkline)

```html
<svg viewBox="0 0 600 200" preserveAspectRatio="none" width="600" height="200" aria-label="6-quarter trend">
  <polyline fill="none" stroke="var(--blue)" stroke-width="3" stroke-linecap="round"
    points="0,160 100,140 200,150 300,110 400,90 500,80 600,40" />
  <circle cx="600" cy="40" r="8" fill="var(--orange)" />
</svg>
```

Sparkline left → right, ending dot in orange to mark "this quarter." Six points = six quarters of history. No legend, no axis — the context line below carries the meaning.

---

## Workflow

1. **Lock the headline metric first.** Before any slide, agree what number defines the quarter. ARR? Active accounts? Retention? One number.
2. **Draft the misses BEFORE the wins.** Reverses the usual flinch. If you can't name 3 misses, the review isn't honest enough yet — push back to the owner.
3. **Tie each bet to a miss when possible.** `Bet 01: launch self-serve` directly responds to `Miss 03: activation plateaued`. The narrative arcs.
4. **Use the `/deck` framework for the canvas.** Don't reinvent the keyboard nav, the scaling, or the print stylesheet. Paste the framework, fill in these 8 slides.
5. **Run `/critique` after the draft.** A QBR scoring Cn ≤ 3 means the KPI tiles drift across slides — usually the cause is each KPI slide's number sitting at a different size. Hoist the number style into one CSS rule.

---

## Anti-patterns

- **All wins, no misses.** Reads as a brochure; loses the executive audience immediately. Three misses, honestly named.
- **6-bullet "wins" slides.** Wins are 3. If you have 6 wins, two were small — combine. If they were all big, the bar was set too low in planning.
- **Bets without owners.** A bet without an owner is a wish. Every bet has a name attached.
- **Mixing sans serif in the body.** The retro-modern signature is mono header + serif body. A sans body destroys the brand.
- **Decorative charts that don't tell the story.** Bar charts and pie wedges that just rephrase the number waste the slide. Use a 6-quarter sparkline that shows trajectory — that's the story the number can't tell alone.
- **Q&A slide that says "Thank You!" with a giant exclamation.** Replace with `Thanks. Questions?` — the lowercase, the period, the comma. Tone matters.
- **Cover that lists 4 metrics.** One headline metric. The remaining KPIs are slides 2–4; the cover holds one number that frames the quarter.
