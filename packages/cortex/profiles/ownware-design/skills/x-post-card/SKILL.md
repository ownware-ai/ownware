---
name: x-post-card
description: 'Standalone 1600×900 (16:9) X-style post card — the share image itself, not OG meta — for product launches, manifesto threads, announcements. 60–80% canvas overlay text, brand mark micro bottom-left. Use for "X-post hero image", "tweet-shaped image card", "drop announcement card native to X". Distinct from /twitter-card OG-meta. Skip for short tweets without images and for Instagram-square aspect.'
trigger: /x-post-card
---

# X-Post Card — 16:9 share image, native-to-X composition

## Overview

The X share card sits next to the link in someone's feed; on X's longform/article mode it's the hero image of the post itself. The skill produces a single 1600×900 image-shaped HTML artifact (16:9, the X large-image preview ratio) with a dense overlay composition: kicker chip, oversized claim, supporting line, brand mark micro-corner.

Its job is one thing: stop the scroll. Density and contrast carry it. Restraint kills it. Pair with `/artifact` for file shape; this skill specializes on the X-feed context and the image-text ratio rules.

---

## Critical Constraints — read these first, every time

1. **Canvas is fixed 1600×900 (16:9).** Same ratio X uses for the large-image preview. Smaller renders at lower quality on retina; larger gets downscaled and softens. 1600×900 is the sweet spot.
2. **Text occupies 60–80% of canvas vertically, top-aligned.** Bottom 20–40% is the visual breathing room and brand-mark zone. Bottom-aligned text on this aspect gets cropped on some clients (X's profile/embed previews crop the top).
3. **Three text blocks max, in order: kicker → claim → support.** No four-block layouts. The feed gives you 1–2 seconds; the third block is where signal turns into clutter.
4. **The claim is ONE line, ≤ 10 words, ≤ 70 characters.** This is the load-bearing copy. If your claim wraps to two lines on the canvas, rewrite the copy or shrink the type. A claim that wraps lost to a claim that didn't.
5. **High contrast on the type: at least 7:1.** Feeds are scrolled fast on phones in bright sun. White on a dark gradient, or near-black on cream — pick a high-contrast pair. Never grey-on-grey for the claim.
6. **Brand mark is micro, bottom-left.** Wordmark or logo at ~20–28px height. Anything bigger competes with the claim. Bottom-left because the bottom-right corner is where X overlays its own UI chrome in some embeds.

---

## The token block (paste verbatim into `:root`)

```css
:root {
  --card-w: 1600px;
  --card-h: 900px;
  --bg-start: #0B0F19;       /* the dark gradient start — tune per content */
  --bg-end: #1E2540;         /* the dark gradient end */
  --fg: #FFFFFF;
  --muted: rgba(255,255,255,0.7);
  --accent: #1D9BF0;          /* X-feed blue, used in kicker chip and a single underline */
  --font-display: "Inter", "Inter Tight", -apple-system, system-ui, sans-serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
}
body { margin: 0; background: #0a0a0a; display: grid; place-items: center; min-height: 100vh; }
.card {
  width: var(--card-w); height: var(--card-h);
  background: linear-gradient(135deg, var(--bg-start) 0%, var(--bg-end) 100%);
  color: var(--fg); font-family: var(--font-body);
  position: relative; overflow: hidden; border-radius: 14px;
}
```

For a light variant flip the tokens — `--bg-start: #F7F4EE`, `--bg-end: #E0D6BD`, `--fg: #0B0F19`, `--muted: rgba(11,15,25,.7)`. The composition rules don't change.

---

## Rubric — the X-post composition

### 1. The lockup region (top 60–80%)

```css
.lockup {
  position: absolute;
  inset: 80px 80px auto 80px;
  display: grid; gap: 28px;
  max-width: 1440px;
}
.lockup .kicker {
  display: inline-block; width: max-content;
  padding: 6px 14px;
  background: rgba(29, 155, 240, 0.15);
  color: var(--accent);
  border: 1px solid rgba(29, 155, 240, 0.4);
  border-radius: 999px;
  font-size: 20px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;
}
.lockup .claim {
  font-family: var(--font-display);
  font-size: clamp(80px, 8vw, 124px);
  line-height: 1.02;
  letter-spacing: -0.025em;
  font-weight: 800;
  margin: 0;
  text-wrap: balance;
  max-width: 1300px;
}
.lockup .support {
  font-size: 28px; line-height: 1.4;
  color: var(--muted);
  max-width: 1100px;
  font-weight: 400;
  margin: 0;
}
```

Kicker is a small accent-tinted pill chip. Claim is the load-bearing line at 80–124px, tight letter-spacing, balanced wrap. Support is muted, smaller, two lines max.

### 2. Brand mark (bottom-left, micro)

```css
.brand {
  position: absolute;
  left: 80px; bottom: 64px;
  display: flex; align-items: center; gap: 12px;
}
.brand-mark { width: 28px; height: 28px; }
.brand-wordmark {
  font-size: 22px; font-weight: 700; letter-spacing: -0.02em;
}
.brand-url {
  font-size: 18px; color: var(--muted); margin-left: 4px;
}
.brand-url::before { content: "·"; margin-right: 8px; color: var(--muted); }
```

```html
<div class="brand">
  <svg class="brand-mark" viewBox="0 0 32 32">
    <!-- The product's own mark, inline SVG -->
    <rect width="32" height="32" rx="8" fill="var(--accent)"/>
    <text x="16" y="22" text-anchor="middle" font-size="20" font-weight="800" fill="white">T</text>
  </svg>
  <span class="brand-wordmark">Ownware</span>
  <span class="brand-url">ownware.dev</span>
</div>
```

Logo + wordmark + URL, all small, all bottom-left. Total height under 30px.

### 3. Bottom-right (optional date / version stamp)

```css
.stamp {
  position: absolute;
  right: 80px; bottom: 64px;
  font-size: 16px; color: var(--muted);
  letter-spacing: 0.12em; text-transform: uppercase;
}
```

`v0.4 · Feb 14, 2026` — small, muted, lowercased contextually. Optional; skip if the card is timeless.

### 4. The optional decorative motif

When the card has only a kicker + claim + small support, the bottom 30% can feel empty. Fill it with a subtle decorative SVG in the bottom-right — a low-opacity geometric motif (a few overlapping circles, or a single sweeping curve) in the accent color at 8–12% opacity. NOT a hero photo, NOT a screenshot.

```html
<svg class="motif" viewBox="0 0 800 400" preserveAspectRatio="xMaxYMax meet">
  <circle cx="700" cy="350" r="180" fill="var(--accent)" fill-opacity=".10"/>
  <circle cx="700" cy="350" r="120" fill="var(--accent)" fill-opacity=".08"/>
  <circle cx="700" cy="350" r="60" fill="var(--accent)" fill-opacity=".05"/>
</svg>
```

```css
.motif { position: absolute; right: 0; bottom: 0; width: 50%; height: 50%; pointer-events: none; }
```

---

## Concrete examples

### Example 1 — a product launch card

Content: Ownware v0.4 launch. Tagline "Your agent. Your laptop. Your rules."

- **Canvas:** 1600×900, dark gradient `#0B0F19 → #1E2540`, rounded 14px.
- **Kicker:** "v0.4 · Launching today" in X-blue chip.
- **Claim:** "Your agent. Your laptop. Your rules." — 124px Inter 800, white, tight letter-spacing.
- **Support:** "Local-first AI that doesn't ship your data anywhere." — 28px Inter 400, muted white.
- **Brand mark (bottom-left):** blue square with "T", wordmark "Ownware", `· ownware.dev`.
- **Stamp (bottom-right):** "v0.4 · Feb 14, 2026" small caps muted.
- **Motif (bottom-right back):** concentric blue circles at 10% opacity, sweeping in from off-canvas.

Full HTML:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ownware v0.4 — X-post card</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root { --card-w:1600px; --card-h:900px; --bg-start:#0B0F19; --bg-end:#1E2540;
            --fg:#fff; --muted:rgba(255,255,255,.7); --accent:#1D9BF0;
            --font-display:"Inter",sans-serif; --font-body:"Inter",sans-serif; }
    body { margin:0; background:#0a0a0a; display:grid; place-items:center; min-height:100vh; }
    .card { width:var(--card-w); height:var(--card-h);
            background:linear-gradient(135deg, var(--bg-start) 0%, var(--bg-end) 100%);
            color:var(--fg); font-family:var(--font-body);
            position:relative; overflow:hidden; border-radius:14px; }
    .lockup { position:absolute; inset:80px 80px auto 80px; display:grid; gap:28px; max-width:1440px; }
    .lockup .kicker { display:inline-block; width:max-content; padding:6px 14px;
                      background:rgba(29,155,240,.15); color:var(--accent);
                      border:1px solid rgba(29,155,240,.4); border-radius:999px;
                      font-size:20px; letter-spacing:.08em; text-transform:uppercase; font-weight:600; }
    .lockup .claim { font-size:clamp(80px,8vw,124px); line-height:1.02; letter-spacing:-.025em;
                     font-weight:800; margin:0; text-wrap:balance; max-width:1300px; }
    .lockup .support { font-size:28px; line-height:1.4; color:var(--muted);
                       max-width:1100px; font-weight:400; margin:0; }
    .brand { position:absolute; left:80px; bottom:64px; display:flex; align-items:center; gap:12px; }
    .brand-mark { width:28px; height:28px; }
    .brand-wordmark { font-size:22px; font-weight:700; letter-spacing:-.02em; }
    .brand-url { font-size:18px; color:var(--muted); margin-left:4px; }
    .brand-url::before { content:"·"; margin-right:8px; color:var(--muted); }
    .stamp { position:absolute; right:80px; bottom:64px; font-size:16px; color:var(--muted);
             letter-spacing:.12em; text-transform:uppercase; }
    .motif { position:absolute; right:0; bottom:0; width:50%; height:50%; pointer-events:none; }
  </style>
</head>
<body>
  <div class="card" data-cx-id="card">
    <div class="lockup" data-cx-id="lockup">
      <span class="kicker">v0.4 · Launching today</span>
      <h1 class="claim">Your agent. Your laptop. Your rules.</h1>
      <p class="support">Local-first AI that doesn't ship your data anywhere.</p>
    </div>
    <svg class="motif" viewBox="0 0 800 400" preserveAspectRatio="xMaxYMax meet">
      <circle cx="700" cy="350" r="180" fill="var(--accent)" fill-opacity=".10"/>
      <circle cx="700" cy="350" r="120" fill="var(--accent)" fill-opacity=".08"/>
      <circle cx="700" cy="350" r="60" fill="var(--accent)" fill-opacity=".05"/>
    </svg>
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="8" fill="var(--accent)"/>
        <text x="16" y="22" text-anchor="middle" font-size="20" font-weight="800" fill="white">T</text>
      </svg>
      <span class="brand-wordmark">Ownware</span>
      <span class="brand-url">ownware.dev</span>
    </div>
    <span class="stamp">v0.4 · Feb 14, 2026</span>
  </div>
</body>
</html>
```

Plus the X post copy that accompanies it (kept under 280 characters):

> Ownware v0.4 ships today.
>
> Your agent runs on your laptop. Your keys stay encrypted on your machine — Ownware never sees them, or your data.
>
> Local-first AI, the way it was supposed to be.
>
> ownware.dev

That's the pair: the image card + the X post copy. Both are part of the skill's output when the user asks for "an X-post card."

### Example 2 — a manifesto/thread-opener card (light variant)

Content: Thread on "the case for local-first AI."

- **Tokens flipped to light:** `--bg-start: #F7F4EE`, `--bg-end: #E0D6BD`, `--fg: #0B0F19`, `--muted: rgba(11,15,25,.65)`.
- **Kicker:** "THREAD · 1/9" in dark chip on cream.
- **Claim:** "We were sold convenience and called it progress." — 100px Inter 800, near-black.
- **Support:** "Why local-first AI is the only AI that's actually yours." — 26px Inter 400.
- **Brand mark:** same Ownware lockup, dark version on cream.
- **Stamp:** "FEB 14, 2026" muted caps.
- **Motif:** single sweeping curve in `rgba(11,15,25,.06)` from bottom-right.

Same skeleton, mood inverted. Light cards work for manifesto / opinion / editorial-tone threads; dark cards work for product launches and announcements.

---

## Anti-patterns

- **Claims that wrap to 3+ lines on the canvas.** The claim is one-line. Two is the absolute limit (only at small support sizes). Three lines means the copy is wrong, not the type.
- **Brand mark at hero size.** A 200px logo competes with the claim and turns the card into a corporate slide. Brand stays micro (~28px logo) bottom-left.
- **Stock photo backgrounds.** Banned. Gradient + optional SVG motif only. Photo-backed X cards age badly and read as ad-creative.
- **Center-aligned text on full canvas.** Top-aligned text holds the eye and survives crops; centered text on 1600×900 floats and gets sliced by client previews.
- **More than one accent color.** One blue, one cream/white, one near-black. Adding a second accent breaks the X-feed familiarity.
- **Rendering at fluid width.** The card must be exactly 1600×900 when captured. A responsive version is a different artifact.
- **Forgetting the X post copy.** When the user asks for an X-post card, the deliverable is the *image plus the post text* — ≤ 280 characters, written to match the card's claim, with a URL on its own line. Image without copy is half the job.
- **Decorative motif at >15% opacity.** It's a tint, not a layer. Anything above 15% reads as foreground and competes with the type.
