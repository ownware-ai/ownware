---
name: xiaohongshu-card
description: 'Xiaohongshu (Little Red Book) social card — 3:4 portrait, 1080×1440, CJK-friendly type stack, generous emoji/sticker decoration, warm brand-discovery vibe. Use for product-launch cards, beauty/lifestyle drops, tip/listicle posts in the Xiaohongshu/小红书 style. Pairs with /poster-design for the layout discipline; this skill owns the platform-native warmth. Skip for Twitter-style posts (different aspect, colder palette).'
trigger: /xiaohongshu-card
---

# Xiaohongshu Card — warm 3:4 social cards for Little Red Book

## Overview

Xiaohongshu (小红书) is a Chinese product-discovery social platform; its native aesthetic is warm, decorated, and emoji-heavy. This skill ships a single 1080×1440 card (or a 3–9 card carousel) tuned for that platform. CJK-ready type stack, soft pastel palette, big stickers, body cards stacked under a punchy headline.

Adjacent skills: `/poster-design` for the underlying layout discipline; `/instagram-post` (if present) for the colder Western aesthetic. Use this one when the brief names Xiaohongshu, 小红书, beauty/lifestyle, or product-launch with "warmth".

---

## Critical Constraints

1. **Canvas is 1080×1440 portrait** per card. Carousel format: 3–9 cards stacked vertically in one HTML file, each card a `.card` block at exact dimensions. 9 is the platform max; 3–6 is the sweet spot.
2. **Type stack CJK-first.** Display: `"Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", -apple-system, "Helvetica Neue", sans-serif`. Latin fallback works for English drafts; the agent emits the CJK stack regardless so Chinese copy renders correctly when the user swaps it in.
3. **Palette is warm pastels — Morandi or peach.** Background `#fdf4ec` (peach paper) or `#f5ede4` (Morandi cream). Accent options: brand-pink `#ff6b8a`, peach `#ff8c69`, lavender `#a78bfa`, sage `#86b394`. ONE primary accent per card. No greys colder than `#7a6a5d`.
4. **Type sizes scale large.** Display headline `96–140px`. Section title `52px`. Body `34–40px` (Xiaohongshu is read on phone — anything under 32px is invisible at scroll).
5. **Decoration is required, not optional.** Each card carries 2–4 visible decorations: emoji at large size (48–80px), CSS-drawn stickers (a circle with text inside, a star, a tag pill), color-block shapes behind text. Naked layouts look "designed in Notion" and fail on the platform.
6. **Border radius is generous.** Card outer `32px`. Inner content blocks `20–24px`. Pill tags `999px`. No sharp corners.
7. **Watermark bottom-right.** `@username · DD MMM` in `18px`, opacity 0.5. Always present. The platform's organic-reach convention.
8. **Headline ≤ 14 Chinese characters / ≤ 8 English words.** Anything longer doesn't read at thumbnail.

---

## Card anatomy — 4 zones every card holds

1. **Tag pill** (top-left or top-center): `干货预警` / `建议收藏` / `亲测有效` / Latin equivalents like `MUST READ` / `INSIDER TIP`. 22px on a colored pill, bold weight.
2. **Headline block** (upper 40% of card): the punchy hook. Tight line-height (`1.05`), heavy weight (700–900), `text-wrap: balance`. Often a single emoji adjacent for warmth.
3. **Body card** (middle 50%): one core observation per card. May contain a sub-bullet list (max 3 items), product detail, or comparison row. Set on a slightly-different background tint to layer over the card background.
4. **Footer strip** (bottom 10%): watermark + card index `1 / 6` + brand mark. Smallest type, muted.

---

## Concrete example — 6-card beauty product launch carousel

Brief: a new clean-beauty lipstick launch. 6 cards, peach-Morandi palette, accent peach `#ff8c69`.

### Tokens

```css
:root {
  --bg: #fdf4ec;                 /* peach paper */
  --surface: #ffffff;
  --fg: #2a1f17;
  --muted: #7a6a5d;
  --accent: #ff8c69;             /* peach */
  --accent-soft: #ffd9c9;
  --tag-bg: #ff6b8a;             /* pink for the must-read tag */
  --font-cjk: "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC",
              -apple-system, "Helvetica Neue", sans-serif;
}
```

### Card 1 — Cover (`COVER`)

```html
<section class="card" data-cx-id="card-1-cover">
  <span class="tag" style="background:var(--tag-bg);">✨ MUST READ</span>
  <h1 style="font:900 132px/0.95 var(--font-cjk); letter-spacing:-0.03em; text-wrap:balance;">
    The 6 lipsticks <br/>I rebuy <span style="color:var(--accent);">every single time</span> 💋
  </h1>
  <p style="font:500 36px/1.4 var(--font-cjk); color:var(--muted); margin-top:32px;">
    Tested on dry lips, photographed in real daylight, swatched on three skin tones.
  </p>
  <div class="sticker" style="position:absolute; right:60px; bottom:200px;">
    <div style="width:180px; height:180px; border-radius:50%; background:var(--accent-soft);
                display:grid; place-items:center; font:700 28px var(--font-cjk); color:var(--fg);
                transform:rotate(-8deg);">
      SWIPE →<br/>6 picks
    </div>
  </div>
  <div class="footer">@mia.lab · 26 May · 1 / 6</div>
</section>
```

### Card 2 — First pick

```html
<section class="card" data-cx-id="card-2-pick-1">
  <span class="tag" style="background:var(--accent);">PICK 01</span>
  <h2 style="font:800 88px/1.05 var(--font-cjk); letter-spacing:-0.02em;">
    Daily nude that doesn't read beige 🌰
  </h2>
  <div class="product-card" style="background:#fff; border-radius:24px; padding:48px; margin-top:48px;">
    <div style="display:flex; gap:32px; align-items:center;">
      <div style="width:140px; height:200px; background:linear-gradient(180deg,#d4a574,#a67c52); border-radius:16px;"></div>
      <div>
        <p style="font:700 44px/1.2 var(--font-cjk); margin:0;">Bare Truth · 04 Hazel</p>
        <p style="font:500 32px/1.4 var(--font-cjk); color:var(--muted); margin:12px 0 0;">
          Satin · matte-leaning · 8h wear · $26
        </p>
      </div>
    </div>
    <ul style="font:500 32px/1.7 var(--font-cjk); color:var(--fg); margin:32px 0 0; padding-left:32px;">
      <li>✅ Doesn't bleed on dry lips</li>
      <li>✅ Reads warm-neutral, not pink</li>
      <li>⚠️ Skip if you wanted glossy</li>
    </ul>
  </div>
  <div class="footer">@mia.lab · 26 May · 2 / 6</div>
</section>
```

### Cards 3–5

Same pattern as card 2, alternating accent treatment — card 3 uses lavender `#a78bfa` for variety, card 4 returns to peach, card 5 uses sage `#86b394`. The headline rhythm holds: emoji at the end, one observation per card.

### Card 6 — Summary + CTA

```html
<section class="card" data-cx-id="card-6-summary">
  <span class="tag" style="background:var(--accent);">SAVE & SHARE</span>
  <h2 style="font:800 96px/1.05 var(--font-cjk); letter-spacing:-0.02em;">
    My ranking 👇
  </h2>
  <ol style="font:600 44px/1.5 var(--font-cjk); margin-top:48px; padding-left:60px;">
    <li>Bare Truth 04 — daily</li>
    <li>Velvet Hour 12 — date</li>
    <li>Rouge Letter 08 — bold</li>
    <li>Petal Slip 02 — Y2K</li>
    <li>Quiet Plum 14 — autumn</li>
    <li>Sundown 09 — beach</li>
  </ol>
  <div class="cta" style="margin-top:64px; padding:36px 48px; background:var(--accent); color:#fff;
                          border-radius:999px; font:800 42px var(--font-cjk); display:inline-block;">
    Follow @mia.lab for monthly drops →
  </div>
  <div class="footer">@mia.lab · 26 May · 6 / 6</div>
</section>
```

### The `.card` shell CSS

```css
.card {
  width: 1080px; height: 1440px;
  background: var(--bg);
  color: var(--fg);
  padding: 80px 60px 100px;
  position: relative;
  border-radius: 32px;
  overflow: hidden;
  margin: 24px auto;
}
.tag {
  display: inline-block; padding: 12px 28px;
  border-radius: 999px;
  color: #fff; font: 800 22px/1 var(--font-cjk);
  letter-spacing: 0.04em; text-transform: uppercase;
}
.footer {
  position: absolute; bottom: 36px; right: 60px;
  font: 500 22px/1 var(--font-cjk); color: var(--muted); opacity: 0.6;
}
```

User screenshots each `.card` block individually (or runs the whole HTML through a headless screenshot tool) to export as PNG files for upload.

---

## Workflow

1. **Pick the accent first.** Peach for beauty/lifestyle. Lavender for tech/AI-tools. Sage for wellness. Pink for fashion. The accent decides the deck's emotional read.
2. **Outline N cards before writing CSS.** 6 cards = cover + 4 picks + summary. 9 cards = cover + 7 picks + CTA. Map each card to one observation; if a card can't be summarized in one observation, it's two cards.
3. **Place exactly one emoji per major text block.** More than one per block reads as spam. Zero reads as cold.
4. **Always set the CJK font stack** even when the agent's drafting in English. The user usually translates copy before posting; the type stack must already be CJK-ready.
5. **Watermark every card the same.** `@username · date · N / total`. No card breaks this pattern.

---

## Anti-patterns

- **Cold greys and pure black text.** Xiaohongshu's read is warmth — `#2a1f17` not `#000000`, `#7a6a5d` not `#6b7280`.
- **Naked headline, no decoration.** Reads as "this person doesn't understand the platform." Add at least one emoji + one sticker per card.
- **Type smaller than 32px for body.** Phone-only platform; small type is invisible.
- **Five accents across the carousel.** Reads as a swatch test. Pick one primary accent; one secondary accent OK; three is the cap.
- **Latin-only font stack.** Even on English drafts, set the CJK stack so the user can swap copy without re-rendering glyphs.
- **Sharp corners and tight margins.** That's a Twitter card. Xiaohongshu is `32px` corners and `60–80px` margins.
- **Watermark omitted on "internal preview" cards.** Then the user has to add it manually before posting. Always include from card 1.
