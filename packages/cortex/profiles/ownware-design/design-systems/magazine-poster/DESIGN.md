# Magazine Poster

> Category: editorial
> Oversized editorial display type with one saturated accent and asymmetric grid. The art-direction / agency / portfolio / cultural-publication zone.

## 1. Visual theme & atmosphere

This is the "art-directed, not built" system. It belongs on surfaces that want to read as if a magazine art director designed them — an agency landing page, a creative portfolio, a journal of essays, a cultural-festival site, a fashion-week microsite. The signal is *editorial confidence through dramatic scale*: one oversized serif headline that dominates the page, one saturated accent that punches through a warm-paper monochrome, asymmetric grids that break the rectangular safety of normal web layouts, copy treated as art object rather than message body. The system says *"this was composed."*

The difference from `editorial-monocle` (sober editorial) is theatricality. Editorial-monocle is restrained — black-on-paper with a near-black "accent," small refinements, library-quiet. Magazine Poster is *loud* — saturated red on warm paper, hero headlines at 120–180px, deliberately broken grids, rules that interrupt rather than separate. Reach for Magazine Poster when the artifact's brief is "this should feel printed, not built"; reach for `editorial-monocle` when the brief is "this should feel like a longform essay."

## 2. Color palette & roles

- **Background** (`--bg`, `#f3eee3`): warm paper. Reads as unbleached or off-white printed stock. White as a canvas in this system reads as digital and breaks the printed-feel.
- **Surface** (`--surface`, `#ffffff`): clean white, used sparingly — the rare elevated tile or photograph mat. Most of the page sits directly on `--bg`, not on `--surface`.
- **Foreground** (`--fg`, `#0a0a0a`): deep ink. Pure black is correct here — printed display serifs need full density.
- **Muted** (`--muted`, `#5a554c`): warm grey-brown for byline / dateline / metadata.
- **Border** (`--border`, `#dbd4c4`): warm rule color, mid-contrast. Used for fine 1px rule lines under headings, between sections, in table cells — borders here function as typographic rules, not as containers.
- **Accent** (`--accent`, `#e63946`): one saturated red. The system's whole drama comes from this single chromatic note hitting the warm monochrome. Used on the primary CTA, the eyebrow label, one underline, one display-element callout — and nowhere else.
- **Accent hover** (`--accent-hover`, `#c92a36`): darken-on-hover.
- **Accent fg** (`--accent-fg`, `#ffffff`): white on red.
- **Semantic** (`--good` `#3a7a4e`, `--warn` `#c88a1a`, `--bad` `#b03030`): desaturated to fit the warm-paper world. Used very sparingly — this is not a status-heavy system.

The discipline: **one chromatic accent**. Red is the default; alternates are saffron yellow (`#f4a300`), cobalt blue (`#1d4ed8`), or forest green (`#1f6e3a`). Pick ONE per artifact and stay; switching mid-page collapses the system. The whole reason the dramatic feel works is the contrast between the warm monochrome palette and the single bold note — adding a second accent splits the punch.

## 3. Typography rules

- **Font stack:** Recoleta or Tiempos Headline for display (heavy display serif with sharp terminals), Inter for body. The display face must have weight and personality — a thin/elegant display serif here reads as a wedding invitation, not a magazine.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 36 / 56 / 88 / 144 / 200.
- **Body:** 16–17px (a touch larger than the other systems — editorial reading expects generous body). Weight 400 default, 600 for emphasis. Line height 1.65 — looser than UI-default to telegraph "long read."
- **Display:** the system commits to **dramatic scale**. Hero headlines at 120–180px on desktop are normal, not extreme. Weight 600–700 on display. Letter spacing tight: `-0.025em` at all display sizes.
- **Asymmetric type setting.** Display elements often hang outside the body column, run vertically along an edge, or stack with intentional gaps. The grid serves the type, not the other way around.
- **The drop cap.** Long-form essays in this system use a serif drop cap (3–4 lines tall, in `--accent`) at the start of the body. Without a drop cap the system reads as "tall headline on top of a regular blog."
- **Numerals.** Use lining figures for tabular data; oldstyle figures for body prose where the type face supports them.

## 4. Spacing & density

- **Section padding:** 120px vertical on desktop, 80px on mobile. Editorial sections breathe far more than SaaS sections.
- **Body column:** maximum 60–66 characters wide. Wider lines break the editorial reading rhythm.
- **Radius:** 0px. Hard rectangles only. Rounded corners in this system drift toward `editorial-monocle` or `soft-clay`.
- **Gutters:** 24–32px between body columns; 4–8px between display-stack lines (the intentional crowding of display type IS the visual rhythm).

Density runs varied across the page — display dominates, body is generous, captions are tight. This is a magazine layout discipline, not a SaaS one.

## 5. Signature moves & avoid list

**Dramatic display scale is mandatory.** Headlines at 120–180px on desktop are the system; anything smaller flattens the page into a regular blog. If the brief has a long headline that won't fit at that scale, split it across two lines with intentional asymmetric line breaks rather than scaling it down.

**The asymmetric grid.** This system rejects the safety of full-width body columns over symmetric grids. Common moves: a 3-column grid where the body lives in columns 2–3 and column 1 holds an oversized number or a hanging eyebrow; an image that spans columns 2–4 of a 4-column hero while the headline sits in column 1; a sidebar caption that's literally hanging in the margin. The grid breaks deliberately, not accidentally.

**The one decisive flourish per artifact:** in this system, the flourish is usually *one oversized rotated word* (a single word from the headline set in `--accent`, rotated 90° and running up the left edge), *one full-bleed photograph* with the headline overlaid in tight kerning, or *a single drop cap* at the start of the body in red. Pick one.

**Avoid:**

- A white canvas. The warm paper IS the atmosphere.
- Sans display fonts. Switching to Inter Display or Geist for headlines drops the genre into "editorial-monocle."
- Rounded corners.
- Two chromatic accents. One.
- Hero photography of corporate / SaaS subjects. The genre is editorial — use real magazine-style photography (cropped portraits, environmental shots, archival images, illustration) or no imagery at all. A stock photo of a smiling tech worker in this system breaks the brand instantly.
- Marketing-loose body copy. Magazine Poster pairs with magazine writing — strong opening line, real voice, long-form structure. SaaS marketing copy ("Best-in-class platform for…") against this palette reads as a fake magazine, which is worse than a real SaaS page.
- Symmetric "hero on top, three feature cards in a row" layouts. That's a SaaS shape — Magazine Poster lives in column compositions, gutters that vary, intentional vertical asymmetry.
- A drop shadow anywhere. The system reads as printed; shadows are screen artifacts.
