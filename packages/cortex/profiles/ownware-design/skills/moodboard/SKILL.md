---
name: moodboard
description: 'Build a one-file HTML moodboard (palette + type pairings + reference notes + voice samples) BEFORE writing the final artifact, when the brief is fuzzy on taste and a quick visual alignment will save a wasted full-build pass. Use between /discovery and /artifact when the user said "I want it premium but warm" and you need them to point at the right premium-but-warm. Do NOT use as a substitute for /artifact — the moodboard is a strategic alignment file, not the deliverable.'
trigger: /moodboard
---

# Moodboard — align taste in one file, before the full build

## Overview

Sometimes discovery picks the direction, but the user's "premium but warm" and your "premium but warm" are different products. A moodboard is the cheap 5-minute artifact that surfaces the gap before you spend 30 minutes building the wrong landing page. It lives between `/discovery` (we picked the direction) and `/artifact` (we built the file).

The output is a single self-contained HTML file (same shape rules as `/artifact`) with exactly four zones: Palette, Type, References, Voice. The user reads it, nods at three of the four zones, redirects one, and you go build the final artifact knowing taste is aligned.

---

## Critical Constraints

1. **One HTML file. Inline `<style>`. `:root` token block. Same rules as `/artifact`.** A moodboard is an artifact — it just has a tiny information architecture (four zones, fixed order). Do not invent a new file format.
2. **Four zones, fixed order: Palette → Type → References → Voice.** No section breaks, no nav, no hero. The shape is a single scrollable page with four labeled blocks. Predictable shape lets the user scan in 30 seconds.
3. **Every zone hits its minimum content count.** Palette: 5–7 named swatches. Type: 3 H1+body pairings. References: 3–5 "this should feel like X" notes pointing at real public products / artists / brands. Voice: 1 hero headline + 2 supporting lines. Less than these and the user can't form an opinion.
4. **Name every choice.** Swatches have names ("Coastal Ink", "Maine Fog"). Fonts are named ("Fraunces / Inter pairing"). References are named ("feels like the Field Notes website, 2019 era"). Voice samples have role labels ("Hero headline", "Sub-line 1", "Sub-line 2"). Nameless options are unactionable.
5. **No `data-cx-id` anchors needed.** The moodboard is short, single-purpose, and rarely surgically edited. Anchors are for the full artifact.
6. **Skip the `<artifact>` block for moodboards.** They're alignment files, not deliverables. The user previews and replies; we don't pin them as canonical.
7. **End the turn with one sentence: "Which zone needs redirecting?"** Don't ask the user to score each zone or pick favorites. Just one prompt.

---

## The Framework — how to pick each zone's contents from the brief

For any brief, walk these four decisions. Each decision is a lookup, not an improvisation.

### Zone 1 — Palette (5–7 named swatches)

Pick:
- **1 background swatch** — the dominant surface. White, near-black, cream, charcoal.
- **1 foreground swatch** — body text color. Near-black on light, near-white on dark.
- **1 accent swatch** — the brand color the user will react to most strongly. This is the load-bearing choice.
- **1 muted swatch** — secondary text, borders.
- **2 semantic swatches** — `--good` and `--bad`. Optional `--warn` (third semantic if the brief is data-heavy).

Each swatch gets a *name*, not just a hex. "Sage" beats `#a8c7a1`. Names make the user's redirect specific ("less Sage, more Olive") rather than vague ("less green").

### Zone 2 — Type pairings (3 H1 + body samples)

Pick **three** type pairings — not one. The point of a moodboard is to surface options the user couldn't have requested by name. Each pairing is:
- **Display font** — for headlines. Named. Real (Google Fonts, system fonts, or named-paid-with-fallback).
- **Body font** — for paragraph text. Named.
- **A real H1 + body sample** rendered in that pairing. Not lorem ipsum. Sample copy drawn from the brief — if it's a landing page for a fintech app, the H1 sample is a real candidate fintech headline.

Three pairings let the user point: "the second one, but with the first one's body." Single pairing = take it or leave it = no signal.

### Zone 3 — Reference notes (3–5 "feels like X" notes)

Each reference is a single sentence pointing at a *real, public, named thing* the user can look up. Categories you can pull from:
- **Public products** — "feels like Linear's homepage" / "the density of Bloomberg.com".
- **Brands** — "the wordmark energy of Aesop" / "the muted palette of Hermès.com".
- **Artists / designers** — "the typography rhythm of Massimo Vignelli's NYC subway map" / "the color discipline of Saul Bass".
- **Eras / publications** — "1970s Pirelli calendar editorial energy" / "Wallpaper magazine spread density".
- **Specific places / objects** — "feels like a Pantone swatch booklet" / "feels like a Muji store interior".

Three to five. No more, no fewer. Each one points at something the user can search and either nod at or veto.

### Zone 4 — Voice samples (1 hero headline + 2 supporting lines)

Pick the voice axis the brief implies, then write three samples:
- **Hero headline** — the load-bearing line. 6–10 words. No marketing fluff. Specific to the product.
- **Sub-line 1** — clarifies who it's for. One sentence.
- **Sub-line 2** — the proof / detail. One sentence with a specific number or noun.

Voice is half the moodboard's signal. Two products with the same palette and type can feel totally different based on voice — "Built for the 1%" vs "For everyone who's ever forgotten a password."

---

## File shape

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Moodboard · {brief one-liner}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #fafaf7;
      --fg: #1a1a1a;
      --muted: #6b6b6b;
      --border: #e6e3dc;
      --zone-pad: 64px;
      --font-display: "Fraunces", Georgia, serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 var(--font-body); }
    .zone { padding: var(--zone-pad); border-bottom: 1px solid var(--border); }
    .zone-label { font: 12px/1 var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 24px; }
    /* Palette */
    .swatch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }
    .swatch { border-radius: 4px; padding: 16px; min-height: 120px; display: flex; flex-direction: column; justify-content: flex-end; }
    .swatch-name { font-weight: 600; font-size: 13px; }
    .swatch-hex { font-family: ui-monospace, monospace; font-size: 12px; opacity: 0.7; }
    /* Type */
    .type-pair { padding: 24px 0; border-top: 1px solid var(--border); }
    .type-pair:first-of-type { border-top: 0; }
    .type-meta { font: 12px/1.4 ui-monospace, monospace; color: var(--muted); margin-bottom: 12px; }
    .type-h1 { font-family: var(--pair-display); font-size: 44px; line-height: 1.1; margin: 0 0 16px; text-wrap: balance; letter-spacing: -0.01em; }
    .type-body { font-family: var(--pair-body); font-size: 16px; max-width: 56ch; margin: 0; }
    /* References */
    .ref-list { display: grid; gap: 16px; }
    .ref-item { padding: 16px 20px; background: #fff; border-radius: 4px; border: 1px solid var(--border); }
    .ref-item strong { font-family: var(--font-display); font-size: 18px; }
    /* Voice */
    .voice-hero { font-family: var(--font-display); font-size: 56px; line-height: 1.05; margin: 0 0 32px; max-width: 16ch; text-wrap: balance; }
    .voice-sub { font-size: 18px; max-width: 50ch; margin: 0 0 12px; }
    .voice-sub::before { content: '— '; color: var(--muted); }
  </style>
</head>
<body>
  <section class="zone">
    <p class="zone-label">01 · Palette</p>
    <div class="swatch-grid">
      <div class="swatch" style="background:#fafaf7;color:#1a1a1a;border:1px solid #e6e3dc">
        <div class="swatch-name">Maine Fog</div><div class="swatch-hex">#FAFAF7</div>
      </div>
      <!-- 5–7 swatches total -->
    </div>
  </section>

  <section class="zone">
    <p class="zone-label">02 · Type</p>
    <div class="type-pair" style="--pair-display: 'Fraunces', serif; --pair-body: 'Inter', sans-serif">
      <p class="type-meta">Fraunces (display) · Inter (body)</p>
      <h1 class="type-h1">{Real H1 sample from the brief}</h1>
      <p class="type-body">{Real body sample from the brief, two sentences.}</p>
    </div>
    <!-- 3 pairings total -->
  </section>

  <section class="zone">
    <p class="zone-label">03 · References</p>
    <div class="ref-list">
      <div class="ref-item"><strong>Field Notes website (2019)</strong> — restrained editorial density, off-white surface, generous margins.</div>
      <!-- 3–5 refs total -->
    </div>
  </section>

  <section class="zone">
    <p class="zone-label">04 · Voice</p>
    <h2 class="voice-hero">{Hero headline, 6–10 words}</h2>
    <p class="voice-sub">{Sub-line 1: who it's for, one sentence.}</p>
    <p class="voice-sub">{Sub-line 2: the proof / specific noun or number.}</p>
  </section>
</body>
</html>
```

That structure is non-negotiable. Tokens at top, four zones in fixed order, named content in each.

---

## Concrete examples

### Example A — Brief: "indie fintech app for college students"

Decoded:
- Mood: friendly, low-stakes, "your money doesn't have to suck."
- Audience: 18–22, suspicious of banks, lives on Instagram and Discord.
- Reference universe: Cash App, Robinhood (consumer), Monzo (warmth), thrift-store / streetwear vibes.

**Palette (6 swatches):**
- **Backboard** `#0f1115` — near-black background; the app is dark-mode-first.
- **Tablet** `#1a1d24` — surface color, one step up from background.
- **Hi-Lite** `#caff33` — load-bearing accent, electric chartreuse. Reads as "young money."
- **Receipt** `#a8a39a` — muted/border, warm gray.
- **Up** `#4ade80` — `--good`. Mint green.
- **Down** `#ff6b6b` — `--bad`. Soft red.

**Type pairings (3):**
1. **Space Grotesk (display) / Inter (body)** — modern, slightly geometric, B2C-friendly. H1 sample: "Your first paycheck is the first decision."
2. **Instrument Serif (display) / Inter (body)** — editorial wink, a little luxe. H1 sample: "Money you don't have to think about."
3. **GT Maru (display, fallback IBM Plex Sans) / IBM Plex Sans (body)** — playful, rounded, indie. H1 sample: "You're rich now. Sort of."

**References (4):**
- **Cash App's mid-2020 aesthetic** — flat colors, oversized green primary, friendly mono numerals.
- **The Monzo "Plus" launch page** — warm coral on near-black, big number, low-density.
- **Field Notes notebooks** — kraft paper, restrained type, signals "honest small thing."
- **Streetwear drop pages (Aimé Leon Dore)** — single-product focus, generous margins, editorial-confident.

**Voice (1 hero + 2 subs):**
- Hero: **"Your money. No suit required."**
- Sub-line 1: For students figuring it out — paychecks, splits, the rent on a 4-bed.
- Sub-line 2: $0 fees, 4.2% on what you save, and a card that doesn't say "Platinum."

That's the file. The user previews, points at one or two zones to redirect ("love the chartreuse, but the second type pairing — too editorial"), and you go build with confidence.

### Example B — Brief: "B2B compliance tool, must feel trustworthy, audience is enterprise CISOs"

Decoded:
- Mood: serious, restrained, "no surprises."
- Audience: 45+ security executives, decision via committee, hates marketing varnish.
- Reference universe: Vanta, Drata, traditional enterprise but better-designed.

**Palette (7 swatches):**
- **Document** `#fbfbfa` — paper-white background.
- **Ink** `#0e1726` — body text, deep navy-black.
- **Vault** `#1e3a8a` — accent, restrained navy.
- **Stamp** `#5b6471` — muted/borders.
- **Approved** `#15803d` — `--good`.
- **Hold** `#a16207` — `--warn`.
- **Reject** `#991b1b` — `--bad`.

**Type pairings (3):**
1. **Söhne / Inter** — Stripe / Vanta zone. Geometric, neutral, expensive-feeling.
2. **GT America / GT America** — single-family, restrained, B2B default.
3. **Söhne Breit / Söhne** — display variant for the brand wordmark, regular for body. Distinctive without being loud.

**References (4):**
- **Vanta's homepage circa 2024** — restrained palette, oversized stat callouts, very little decoration.
- **The Economist's print pages** — type discipline, generous white space, serious tone.
- **The NYT Politics section interface** — content density done with restraint.
- **Old-school bank statements** — monospace numerals, ruled lines, generous margins.

**Voice (1 hero + 2 subs):**
- Hero: **"SOC 2 in eight weeks, not eight months."**
- Sub-line 1: Built for security teams that have to ship the audit without slowing the business.
- Sub-line 2: 4,000 engineers across 220 companies passed audit on the first try.

---

## Anti-patterns

If you find yourself padding to fill a fifth zone, stop. Four zones, fixed. The whole point is the user scans it fast.

If your swatches are named "Color 1", "Color 2", "Color 3", stop. The naming is the deliverable — a redirect from "less Sage, more Olive" only works if you named the swatches.

If your references are all from the user's own industry, stop. The Field Notes / Vignelli / Pirelli pulls earn the moodboard's existence; "feels like another fintech app" earns nothing. Pull from at least two industries.

If your voice samples are marketing-template lines ("Reimagining X for the modern Y"), stop and rewrite. Voice samples are the moodboard's surface that the user judges hardest — generic copy makes the whole moodboard feel generic.

If you reach for the `<artifact>` block at the end, stop. Moodboards are alignment files. They preview, they get redirected, they get discarded once the real artifact ships. Don't pin them.

If the user has named the direction precisely ("Modern Minimal with cobalt accent, Inter throughout"), do not run this skill. Go straight to `/artifact`. The moodboard is for fuzzy briefs, not crisp ones.
