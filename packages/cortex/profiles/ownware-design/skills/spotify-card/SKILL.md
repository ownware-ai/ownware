---
name: spotify-card
description: 'Square 1080×1080 social card in the Spotify visual idiom — album-art-style image area, bold type overlay, brand mark bottom-right, mood color extracted from the artwork. Use when the brief is "podcast episode card", "playlist share image", or "track-of-the-day post". Skip for non-music content (the idiom misleads), 9:16 Story aspect, and any case needing licensed cover art.'
trigger: /spotify-card
---

# Spotify Card — square social, art-plus-overlay, mood-tinted

## Overview

A standalone share card that borrows the visual familiarity of the Spotify share/now-playing surface — bold artwork, type lockup, brand mark — without copying Spotify's actual UI chrome. Use for podcast episode promos, playlist drops, track posts. Output is a single self-contained HTML file sized to a 1080×1080 square (Instagram square, X image, LinkedIn post).

The skill lives next to the social-card family (X post, OG meta). The shared anchor is `/artifact` for file shape; this skill specializes on the 1:1 social context and the artwork-with-overlay composition.

---

## Critical Constraints — read these first, every time

1. **Square canvas, fixed 1080×1080.** Render the body as a centered 1080×1080 block so it screenshots cleanly. No responsive scaling — square is the medium. (Preview shows it at viewport scale; the artifact is captured at 1080.)
2. **No external image URLs.** No `<img src="https://...">`. The artwork zone is a CSS gradient + an inline SVG composition + a typographic monogram. Stock or licensed cover art is out of scope; we make the art on-card.
3. **Mood color carries the card.** Pick one dominant color for the artwork and let it tint everything — gradient base, type contrast, brand mark. Three-color collages turn the card into a poster, not a Spotify card.
4. **Type overlay on the lower third, never centered.** The artwork breathes in the top 60%, the type lockup sits in the bottom 30–40%, brand mark in the bottom-right corner. Center-overlaid type fights the art.
5. **Brand mark is generic "streaming card" energy, not the Spotify logo.** Inline SVG of three rising bars + a circle frame, in the mood-color tone. Do not draw the Spotify wordmark or trademark logo — we ride the idiom, not the brand.
6. **One typographic family.** Inter or system-sans throughout. Mixing fonts on a 1080-square reads as crowded.

---

## The token block (paste verbatim into `:root`)

```css
:root {
  --card-w: 1080px;
  --card-h: 1080px;
  --bg: #121212;                /* the dark base */
  --art-base: #1E3264;          /* the mood color — pick per content */
  --art-deep: #0D1F3D;          /* the mood color, darker for gradient end */
  --fg: #FFFFFF;
  --muted: #B3B3B3;
  --accent: #1ED760;             /* the streaming-platform green for the brand mark */
  --kicker: rgba(255,255,255,0.7);
  --font-display: "Inter", -apple-system, system-ui, "Helvetica Neue", sans-serif;
  --font-body: "Inter", -apple-system, system-ui, "Helvetica Neue", sans-serif;
}
body { margin: 0; background: #0a0a0a; display: grid; place-items: center; min-height: 100vh; }
.card {
  width: var(--card-w); height: var(--card-h);
  background: var(--bg);
  font-family: var(--font-body);
  color: var(--fg);
  position: relative;
  overflow: hidden;
  border-radius: 16px;
}
```

The two mood color variables are the dial. For "lo-fi midnight" use deep blues; for "afternoon pop" use coral and rose; for "podcast indie" use forest and moss; for "techno" use magenta and ink.

---

## Rubric — the card composition

### 1. Artwork zone (top ~60%, 0 → 640px)

A diagonal gradient `linear-gradient(135deg, var(--art-base) 0%, var(--art-deep) 100%)` is the base. Layered on top: one inline-SVG composition (concentric rings, abstract waveform, geometric monogram) in white at 8–15% opacity. This gives the card a "cover art" silhouette without being a photo.

```html
<div class="art">
  <svg viewBox="0 0 600 600" class="art-mark">
    <circle cx="300" cy="300" r="220" stroke="white" stroke-opacity=".12" fill="none" stroke-width="2"/>
    <circle cx="300" cy="300" r="140" stroke="white" stroke-opacity=".18" fill="none" stroke-width="2"/>
    <text x="300" y="320" text-anchor="middle" font-size="180" font-weight="700"
          fill="white" fill-opacity=".9" letter-spacing="-.04em">LF</text>
  </svg>
</div>
```

```css
.art {
  position: absolute; inset: 0 0 40% 0;
  background: linear-gradient(135deg, var(--art-base) 0%, var(--art-deep) 100%);
  display: grid; place-items: center;
}
.art-mark { width: 70%; height: auto; }
```

The monogram (`LF` for "Lo-Fi") is the single piece of content art. Two-letter monograms work best.

### 2. Type lockup (bottom ~40%, 640 → 1080px)

Kicker → Title → Subtitle → Meta row.

```css
.lockup {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 64px 64px 56px;
  display: grid; gap: 20px;
}
.lockup .kicker {
  font-size: 18px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--accent); font-weight: 600;
}
.lockup h2 {
  font-size: 64px; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em;
  margin: 0; text-wrap: balance;
}
.lockup .sub {
  font-size: 24px; color: var(--muted); margin: 0; font-weight: 400;
}
.lockup .meta {
  font-size: 16px; color: var(--kicker); display: flex; gap: 14px; align-items: center;
}
.lockup .meta::before {
  content: "•"; color: var(--accent); font-size: 22px; line-height: 1;
}
```

The kicker is the format tag ("NOW PLAYING", "NEW EPISODE", "FRIDAY DROP"). The title is the track / episode name. The sub is the artist / show. The meta is duration / date / season-episode.

### 3. Brand mark (bottom-right, generic streaming idiom)

```html
<svg class="brand" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="30" fill="var(--accent)"/>
  <path d="M16 24 Q32 18 48 24" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M16 32 Q32 26 48 32" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M16 40 Q32 34 48 40" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>
```

```css
.brand { position: absolute; right: 56px; bottom: 56px; width: 56px; height: 56px; }
```

Three rising arcs in a circle — the generic streaming-card brand mark. Looks like a streaming platform; isn't a trademark.

### 4. Top corner accent (optional, single-line metadata)

Top-right small chip with track/episode index, e.g. `EP · 014`. Same family as the kicker, smaller.

```css
.index { position: absolute; right: 56px; top: 48px; color: var(--kicker);
         font-size: 14px; letter-spacing: 0.12em; text-transform: uppercase; }
```

---

## Concrete examples

### Example 1 — a podcast episode card

Content: Podcast "Late Night Signal," Episode 014, "What we got wrong about taste," with Sam Cho. Mood: warm midnight blue + amber accent.

- **Canvas:** 1080×1080, rounded 16px, dark base.
- **Artwork zone:** diagonal gradient `#1A2A4A → #0A1228`. Concentric ring SVG with white @ 12% opacity. Center monogram "LN" 180px, white @ 90%.
- **Top-right index:** `EP · 014`, 14px caps letter-spaced.
- **Lockup (bottom 40%):**
  - Kicker (green): "NEW EPISODE"
  - Title (64px white bold): "What we got wrong about taste."
  - Sub (24px muted): "with Sam Cho"
  - Meta (16px, green bullet): "47 min · Season 3 · Feb 14"
- **Brand mark (bottom-right):** green circle with three rising white arcs.

Full HTML:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Late Night Signal — Ep. 014 — share card</title>
  <meta property="og:image" content="self" />
  <meta property="og:image:width" content="1080" />
  <meta property="og:image:height" content="1080" />
  <style>
    :root { --card-w:1080px; --card-h:1080px; --bg:#121212;
            --art-base:#1A2A4A; --art-deep:#0A1228;
            --fg:#fff; --muted:#B3B3B3; --accent:#1ED760; --kicker:rgba(255,255,255,.7);
            --font-body:"Inter",-apple-system,system-ui,sans-serif; }
    body { margin:0; background:#0a0a0a; display:grid; place-items:center; min-height:100vh; }
    .card { width:var(--card-w); height:var(--card-h); background:var(--bg);
            font-family:var(--font-body); color:var(--fg); position:relative;
            overflow:hidden; border-radius:16px; }
    .art { position:absolute; inset:0 0 40% 0;
           background:linear-gradient(135deg, var(--art-base) 0%, var(--art-deep) 100%);
           display:grid; place-items:center; }
    .art-mark { width:70%; height:auto; }
    .index { position:absolute; right:56px; top:48px; color:var(--kicker);
             font-size:14px; letter-spacing:.12em; text-transform:uppercase; }
    .lockup { position:absolute; left:0; right:0; bottom:0; padding:64px 64px 56px;
              display:grid; gap:20px; }
    .lockup .kicker { font-size:18px; letter-spacing:.18em; text-transform:uppercase;
                      color:var(--accent); font-weight:600; }
    .lockup h2 { font-size:64px; line-height:1.05; font-weight:800; letter-spacing:-.02em;
                 margin:0; text-wrap:balance; }
    .lockup .sub { font-size:24px; color:var(--muted); margin:0; font-weight:400; }
    .lockup .meta { font-size:16px; color:var(--kicker); display:flex; gap:14px; align-items:center; }
    .lockup .meta::before { content:"•"; color:var(--accent); font-size:22px; line-height:1; }
    .brand { position:absolute; right:56px; bottom:56px; width:56px; height:56px; }
  </style>
</head>
<body>
  <div class="card" data-cx-id="card">
    <div class="art" data-cx-id="art">
      <svg viewBox="0 0 600 600" class="art-mark">
        <circle cx="300" cy="300" r="220" stroke="white" stroke-opacity=".12" fill="none" stroke-width="2"/>
        <circle cx="300" cy="300" r="140" stroke="white" stroke-opacity=".18" fill="none" stroke-width="2"/>
        <text x="300" y="320" text-anchor="middle" font-size="180" font-weight="700"
              fill="white" fill-opacity=".9" letter-spacing="-.04em">LN</text>
      </svg>
    </div>
    <span class="index">Ep · 014</span>
    <div class="lockup" data-cx-id="lockup">
      <span class="kicker">New Episode</span>
      <h2>What we got wrong about taste.</h2>
      <p class="sub">with Sam Cho</p>
      <p class="meta">47 min · Season 3 · Feb 14</p>
    </div>
    <svg class="brand" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="var(--accent)"/>
      <path d="M16 24 Q32 18 48 24" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M16 32 Q32 26 48 32" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M16 40 Q32 34 48 40" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
    </svg>
  </div>
</body>
</html>
```

That's the canonical card. One file, square, ready to screenshot.

### Example 2 — a playlist drop card with a different mood

Content: Playlist "Friday Afternoon," 28 tracks, mood: rose + coral.

- **Mood colors:** `--art-base: #E36F86`, `--art-deep: #8B2C4F`.
- **Monogram:** "FA" (Friday Afternoon).
- **Kicker:** "PLAYLIST" in green.
- **Title:** "Friday Afternoon."
- **Sub:** "28 tracks · 1h 52m"
- **Meta:** "Curated by you · Updated weekly"
- **Index:** `VOL · 09`
- **Brand mark:** same green-on-white arcs.

Same skeleton, only the four mood-token values changed and the type content. That's the discipline.

---

## Anti-patterns

- **Center-overlaid type across the full card.** Buries the art, weakens the lockup. Type lives in the bottom third only.
- **External image URLs in the artwork zone.** Banned. No `<img src="https://...">`, no placeholder image services. Gradient + SVG only.
- **The actual Spotify wordmark / logo.** Trademark territory. The brand mark is the generic rising-arcs-in-a-circle SVG — readably "streaming card", not a counterfeit.
- **Three or more mood colors in the gradient.** Two-stop gradient only. Three-stop reads as a sunset poster, not a streaming card.
- **Mixed type families.** One sans throughout. Adding a display serif "for the title" breaks the platform-card visual code.
- **Body content above the artwork zone.** The artwork comes first. Title and meta sit at the bottom. Reversing this reads as a header card, not a Spotify card.
- **Rendering at viewport width without the 1080×1080 wrapper.** The card must be capturable at exactly 1080×1080. A fluid card is a different artifact (a hero, not a share card).
- **Decorating the brand mark with text labels ("Listen on…").** The mark stands alone. Adding "Listen on Streaming" turns the card into an ad.
