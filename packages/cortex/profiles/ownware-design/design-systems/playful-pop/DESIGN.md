# Playful Pop

> Category: consumer
> Bright multi-accent canvas with bold chunky type and thick dark borders. The kids-app / creator-tool / consumer-landing zone.

## 1. Visual theme & atmosphere

This is the "unapologetically fun" system. It belongs on surfaces that don't want to read as serious — a kids' learning app, a creator's portfolio, a paid newsletter's landing page, a Duolingo-shaped product. The canvas is bright (pastel yellow, not white), the type is chunky display, the borders are thick dark outlines, and the system carries TWO accents (pink + mint) instead of the usual one. The system says *"come in, this is going to be fun, no one will judge you here."*

This is the only system in the catalog that allows two interactive accents. That's not a license to add a third — three accents drift the system into "rainbow brochure" territory. Two is the budget.

The difference from `soft-clay` (friendly molded surfaces) is energy. Soft Clay is calm-warm; Playful Pop is bright-fast. Reach for Playful Pop when the artifact's brief is "should feel like a smile"; reach for Soft Clay when it's "should feel like a hug."

## 2. Color palette & roles

- **Background** (`--bg`, `#fff5d0`): bright pastel-yellow canvas. White as a canvas in this system collapses it to a regular SaaS theme — the yellow IS the brand atmosphere.
- **Surface** (`--surface`, `#ffffff`): clean white card. The card sits as a clean white shape on the warm-yellow floor.
- **Foreground** (`--fg`, `#1a1438`): deep purple-black. Pure black on this palette reads as cold; the very faint purple cast ties into the pink accent.
- **Muted** (`--muted`, `#6c6585`): cool purple-grey for secondary text. AA on `--surface`; weaker on `--bg`.
- **Border** (`--border`, `#1a1438`): same as `--fg`. **Borders are thick (2–3px) and dark** — they do structural work. A hairline `#e5e5e5` border in this system would be wrong; the dark outline is part of the visual language.
- **Accent** (`--accent`, `#ff5d8f`): pink. Primary CTA, primary hero callout, the link underline, the focus ring.
- **Accent hover** (`--accent-hover`, `#ef4d7f`): darken-on-hover.
- **Accent fg** (`--accent-fg`, `#ffffff`): white on the pink fill.
- **Accent alt** (`--accent-alt`, `#7fd6c2`): mint. The secondary fill option — used for alternating tile color, badge pills, the secondary CTA when one is needed.
- **Accent alt fg** (`--accent-alt-fg`, `#1a1438`): the dark fg sits on mint (white on mint is too low-contrast).
- **Semantic** (`--good` `#2ec07a`, `--warn` `#ffb020`, `--bad` `#ef4d4d`): saturated, no desaturation — the system lives at this saturation level so semantics fit in.

The discipline: **two accents, no more**. The pink does primary action; the mint does pairing / alternation. If the brief asks for "more color," tint individual decorative shapes (a sky-blue circle in the hero, a lavender squiggle behind a headline) — do NOT add a third interactive accent. Pink, mint, and the dark/yellow chord are the entire interactive palette.

## 3. Typography rules

- **Font stack:** Recoleta or Space Grotesk for display (chunky, friendly geometric), Inter for body. The display face MUST have weight and character — a thin/elegant display font in this system reads as a mismatch with the bright canvas.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 32 / 48 / 64 / 88.
- **Body:** 16px on marketing, 14px on dense UI. Weight 400 default, 600 for emphasis.
- **Display:** weight 700 (bold) or 800 (extrabold). Display sizes lean LARGER than the other systems — a hero h1 at 88px is normal. Tight tracking: `letter-spacing: -0.02em` at all display sizes.
- **Line height:** 1.55 on body (loose, friendly), 1.05 on display (display sizes lean tight to feel chunky).
- **text-wrap:** `pretty` on `<p>`, `balance` on h1 / h2.
- **Underlines:** links and emphasized text in body use a chunky underline (`text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 4px;`). This is part of the system's hand-drawn feel.

## 4. Spacing & density

- **Section padding:** 96px vertical on desktop, 60px on mobile.
- **Card padding:** 24–32px. Generous; the cards are personality, not just containers.
- **Radius:** 14px on cards. 999px (full pill) on every button — buttons in this system are ALWAYS pills. A rectangular button breaks the genre.
- **Gutters:** 20–24px between cards.

Density runs medium-loose. Playful Pop is a marketing-energy system; if the brief is "show 80 rows of dense data", you've picked wrong — use `tech-utility` or `terminal-grid`.

## 5. Signature moves & avoid list

**Thick dark borders are mandatory.** Cards, buttons, inputs, callouts — all get a 2–3px `--border`-colored outline. The combination of bright canvas + bright surface + thick dark border is the visual signature; a hairline border or a no-border card in this system reads as "kids' app starter template" rather than "deliberately designed Playful Pop."

**The offset shadow.** Cards in this system use a hard offset shadow rather than a soft drop shadow — a non-blurred shadow displaced down-right by 6–8px in the dark border color:

```css
.card {
  background: var(--surface);
  border: 3px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 6px 6px 0 var(--border);
}
```

This is borrowed from neo-brutalist UI but lives comfortably here because the bright palette softens it. Without this offset shadow, cards read as flat — the visual language is *graphic*, not *minimal*.

**The one decisive flourish per artifact:** in this system, the flourish is usually *one oversized hand-drawn decoration* (a squiggle, an underline, a star burst, a hand-pointing arrow) on the hero, *one tilted element* (a card or callout rotated 2–4 degrees), or *a single chunky pill CTA* sized 1.5× the body button height with the offset shadow exaggerated. Pick one.

**Avoid:**

- White canvas. The bright yellow `--bg` IS the brand atmosphere.
- Hairline borders. The genre uses thick `--border`-colored outlines.
- Rectangular buttons. Pills only.
- A third interactive accent. Pink + mint is the budget.
- Soft, blurred drop shadows. The system uses hard offset shadows.
- Elegant or thin display fonts. The display face is chunky; thin display reads as a mismatch.
- Pure-black text. The `--fg` is faintly purple to tie into the pink — pure black reads as cold against the warm canvas.
- Photography of corporate-looking people. The genre is illustrated, expressive, hand-drawn-feeling. A stock photo of a smiling tech worker in this system breaks the brand instantly.
- Subdued / corporate copy voice. The visual language commits to fun; copy that reads as "Best-in-class enterprise solutions" against this palette feels dissonant. Pair the visuals with playful, direct, conversational copy.
