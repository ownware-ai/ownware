---
name: twitter-card
description: 'Twitter/X share-card design and Open Graph meta tags — summary_large_image at 1200×675 (the dominant format), summary at 144×144 thumb. Ships as a single HTML preview file plus the og: + twitter: meta-tag block to paste into the parent site. Use when the brief is "make a card I can attach to a tweet" or "design our X share preview". Skip when the brief is a Reddit link preview — use /reddit-card — or a generic OG image without Twitter-specific framing.'
trigger: /twitter-card
---

# Twitter Card — share-preview design + OG meta tags

## Overview

A Twitter card has two parts the agent must deliver together: **the image** (a 1200×675 HTML preview that screenshots cleanly) and **the meta-tag block** that tells X / Twitter and every other OG-aware crawler how to render the link. Half a deliverable is no deliverable — the prettiest card with no `<meta>` tags still renders as a plain blue URL.

This skill is for cards meant to BE the share preview (the image attached to a tweet via OG tags, OR a static image dropped into a post). For Reddit-flavored cards, use `/reddit-card` — Reddit's crawler quirks and community vibes diverge enough to warrant the split.

---

## Critical Constraints — read these first, every time

1. **Canvas: 1200×675 (16:9), `summary_large_image`.** This is the default. The smaller `summary` variant (144×144 thumb) is reserved for utility / status pages where the card image is the brand mark — rarely the right pick.
2. **Safe area: keep all critical text inside a 1080×608 inner box (60px margin all sides).** Twitter crops cards differently on mobile vs web vs in-reply contexts. Don't put the headline at the edge.
3. **One focal element. One headline. One brand mark.** Three things on a 1200×675 frame. More than that and the card reads in-feed as a busy thumbnail; the eye doesn't catch any of them.
4. **Headline: 56–80px, font-weight 700, line-height 1.05.** Smaller text disappears in the in-feed thumbnail. Keep it short: 6–14 words. Use `text-wrap: balance` so it breaks evenly.
5. **High contrast text-over-image.** If the card has a photo background, add a 40–60% darken overlay before the text layer. Body text at AA contrast minimum against the final composited background.
6. **Brand mark bottom-right OR bottom-left, never centered.** Centered logos compete with the headline. Corner placement is the convention; 11–14px wordmark + 20–32px mark.
7. **Meta tags are mandatory.** Without the `<meta>` block, the card is invisible to crawlers. The image's `<meta property="og:image">` and `<meta name="twitter:image">` must point to an absolute URL — relative paths don't resolve outside the parent host.
8. **No external font CDN in the preview file.** Twitter / X strips remote stylesheets when generating its own preview. Use system fonts in the HTML preview; the agent's job is to make it screenshot clean.

---

## Framework — the meta-tag block (memorize)

Every Twitter card delivery includes this block, ready to paste into the parent page's `<head>`. Replace the values; do not invent fields.

```html
<!-- Open Graph (works for Facebook, LinkedIn, iMessage, Discord, Slack, et al.) -->
<meta property="og:type"        content="article" />
<meta property="og:title"       content="Page title — under 70 chars" />
<meta property="og:description" content="One-line description, under 200 chars. Reads as the subhead." />
<meta property="og:image"       content="https://example.com/share-card.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="675" />
<meta property="og:url"         content="https://example.com/page" />
<meta property="og:site_name"   content="Brand name" />

<!-- Twitter / X specific (overrides og: when both present) -->
<meta name="twitter:card"        content="summary_large_image" />
<meta name="twitter:site"        content="@brandhandle" />
<meta name="twitter:creator"     content="@authorhandle" />
<meta name="twitter:title"       content="Page title — under 70 chars" />
<meta name="twitter:description" content="One-line description, under 200 chars." />
<meta name="twitter:image"       content="https://example.com/share-card.png" />
<meta name="twitter:image:alt"   content="Plain-English description of the card image for screen readers." />
```

Notes that catch agents out:

- **`og:image` MUST be absolute** (`https://…`), not `./share.png`. Relative URLs are silently ignored by the crawler.
- **`twitter:image:alt`** is mandatory for accessibility — set it.
- **`twitter:card`** value: `summary_large_image` for 1200×675, `summary` for 144×144 thumb. Anything else is invalid.
- After deploying, validate with the Twitter Card Validator (`cards-dev.twitter.com/validator`) once — caches are aggressive.

---

## Concrete examples — two full patterns

### Example 1 — Quote-style summary_large_image (1200×675)

A canonical share card: dark background, large pull-quote, attribution, brand mark bottom-right. Screenshot the rendered HTML at 1200×675 and ship that PNG alongside the meta-tag block.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Share card · Ownware quote</title>
  <style>
    :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff; }
    body { margin: 0; }
    .card {
      width: 1200px; height: 675px;
      background: radial-gradient(circle at 30% 20%, #1a2233 0%, var(--bg) 70%);
      color: var(--fg);
      font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
      padding: 60px 80px;                 /* 60px safe-area margin */
      box-sizing: border-box;
      position: relative;
      display: flex; flex-direction: column; justify-content: center;
    }
    .card-label {
      font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--accent); font-weight: 600; margin-bottom: 28px;
    }
    .card-quote {
      font-size: 64px; font-weight: 700; line-height: 1.05; letter-spacing: -0.015em;
      margin: 0; max-width: 18ch; text-wrap: balance;
    }
    .card-attribution {
      margin-top: 32px; font-size: 22px; color: var(--muted);
    }
    .card-brand {
      position: absolute; right: 80px; bottom: 60px;
      display: flex; align-items: center; gap: 10px;
    }
    .card-brand-mark { width: 28px; height: 28px; background: var(--accent); border-radius: 6px; transform: rotate(45deg); }
    .card-brand-name { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  </style>
</head>
<body>
  <div class="card" data-cx-id="card">
    <span class="card-label">Insight</span>
    <p class="card-quote">Local-first is the only honest position on user data.</p>
    <div class="card-attribution">@ownware · Ownware</div>
    <div class="card-brand">
      <span class="card-brand-mark"></span>
      <span class="card-brand-name">ownware.so</span>
    </div>
  </div>
</body>
</html>
```

One file, no external fonts (system stack), full bleed at 1200×675, safe area respected (60px margin all sides). The label / quote / attribution / brand mark form one clean reading flow: brand-purple label tag pulls the eye, headline lands, byline confirms, brand mark closes the corner.

Paired meta-tag block to ship alongside:

```html
<meta property="og:type"         content="article" />
<meta property="og:title"        content="Local-first is the only honest position on user data" />
<meta property="og:description"  content="Why every credential and conversation in Ownware stays on infrastructure the user owns." />
<meta property="og:image"        content="https://ownware.so/share/local-first.png" />
<meta property="og:image:width"  content="1200" />
<meta property="og:image:height" content="675" />
<meta property="og:url"          content="https://ownware.so/posts/local-first" />
<meta property="og:site_name"    content="Ownware" />
<meta name="twitter:card"        content="summary_large_image" />
<meta name="twitter:site"        content="@ownwareos" />
<meta name="twitter:creator"     content="@ownware" />
<meta name="twitter:title"       content="Local-first is the only honest position on user data" />
<meta name="twitter:description" content="Why every credential and conversation in Ownware stays on infrastructure the user owns." />
<meta name="twitter:image"       content="https://ownware.so/share/local-first.png" />
<meta name="twitter:image:alt"   content="Dark card with the quote 'Local-first is the only honest position on user data', attributed to @ownware · Ownware." />
```

### Example 2 — Data card variant (chart-led, 1200×675)

When the share-worthy content is a number or a chart, lead with the number. Headline becomes the caption.

```html
<div class="card-data">
  <div class="card-data-row">
    <div class="card-data-numeric">
      <div class="card-data-value">98.4%</div>
      <div class="card-data-label">Uptime, last 90 days</div>
    </div>
    <svg class="card-data-chart" viewBox="0 0 360 200" preserveAspectRatio="none">
      <polyline fill="none" stroke="#58a6ff" stroke-width="3"
        points="0,150 30,135 60,140 90,110 120,115 150,90 180,95 210,70 240,80 270,55 300,60 330,40 360,45" />
    </svg>
  </div>
  <p class="card-data-headline">Ownware ran for 90 days. Here's what broke and how we fixed it.</p>
  <div class="card-brand"><span class="card-brand-mark"></span><span class="card-brand-name">ownware.so</span></div>
</div>
<style>
  .card-data { width: 1200px; height: 675px; background: #0d1117; color: #e6edf3;
               font-family: -apple-system, system-ui, sans-serif;
               padding: 60px 80px; box-sizing: border-box; display: flex; flex-direction: column;
               justify-content: space-between; position: relative; }
  .card-data-row { display: flex; gap: 60px; align-items: flex-start; }
  .card-data-value { font-size: 144px; font-weight: 800; line-height: 1; letter-spacing: -0.04em;
                     font-variant-numeric: tabular-nums; }
  .card-data-label { font-size: 18px; color: #8b949e; margin-top: 8px; letter-spacing: 0.04em; }
  .card-data-chart { flex: 1; max-height: 220px; }
  .card-data-headline { font-size: 36px; font-weight: 600; line-height: 1.15; margin: 0; max-width: 22ch; text-wrap: balance; }
  .card-brand { position: absolute; right: 80px; bottom: 60px; display: flex; gap: 10px; align-items: center; }
  .card-brand-mark { width: 28px; height: 28px; background: #58a6ff; border-radius: 6px; transform: rotate(45deg); }
  .card-brand-name { font-size: 18px; font-weight: 600; }
</style>
```

Two zones: top is the data (one huge number + a sparkline), bottom is the headline. `font-variant-numeric: tabular-nums` aligns the digits. The chart's polyline uses `var(--accent)`-style direct hex because the card is exported as PNG — token references won't help once it's rasterised. Same meta-tag block applies, with `twitter:image:alt` describing the metric and trend ("98.4% uptime over 90 days, line chart trending upward").

---

## Anti-patterns

- **Designing the card without the meta tags.** Stop. Half a deliverable. Always ship the `<meta>` block alongside the image.
- **`og:image` set to a relative path.** Stop. Crawlers fetch from absolute URLs only. `./share.png` is silently ignored; the link renders without a card.
- **Missing `twitter:image:alt`.** Stop. Required for accessibility and Twitter rewards cards with alt text in distribution.
- **Headline under 32px on the 1200×675 canvas.** Stop. Mobile in-feed thumbnails downscale to ~600px wide. Anything under 56px in source becomes unreadable.
- **External Google Fonts in the HTML preview.** Stop. When the image is rasterised for the share card (or when X tries to render the HTML), the font load times out and the card falls back to the system font with wrong metrics. Use the system stack.
- **More than three elements competing.** Stop. Label + headline + brand is the rule. A second CTA, a date, an author photo, a logo border — pick three.
- **Brand mark dead center.** Stop. Centered logos fight the headline. Corner placement is the convention.
- **Reusing the same card across summary and summary_large_image.** Stop. They're different aspect ratios (1:1 vs 16:9). Either pick one (default to large) or ship two PNGs.
- **Wrapping critical text up to the edge.** Stop. 60px safe-area margin on all sides; mobile crops are unpredictable.
