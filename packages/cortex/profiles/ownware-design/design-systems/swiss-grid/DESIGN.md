# Swiss Grid

> Category: typographic
> International typographic style — strict 12-column grid, Helvetica, one red accent. The museum / foundation / academic zone.

## 1. Visual theme & atmosphere

This is the "typographically literate" system. It belongs on surfaces that want to read as serious in the *museum* sense, not the SaaS sense — a foundation, an architecture studio's homepage, a museum exhibition site, a university research lab, an academic journal, a translator's portfolio. The lineage is Müller-Brockmann, Hofmann, Lohse, Frutiger — the Swiss typographic tradition of the 1950s–70s applied to web. The system says *"the type IS the design; everything else gets out of the way."*

The difference from `modern-minimal` (contemporary SaaS minimal) is era and discipline. Modern-minimal is 2020s tech-company minimal — Inter, cobalt accent, slight rounding, soft shadows. Swiss Grid is *post-war European modernism* — Helvetica, red accent, zero rounding, no shadows, a visible grid you can almost trace with your finger. Reach for Swiss Grid when the brief calls for cultural seriousness or design literacy; reach for modern-minimal when the brief is "tech startup landing page."

The genre depends on **a visible 12-column grid that the layout actually obeys**. Without it, the system collapses to "white background with Helvetica" — which is just a typography choice, not a design system. The grid IS the system.

## 2. Color palette & roles

- **Background** (`--bg`, `#ffffff`): pure paper-white. Swiss design rejects warm cast — the canvas is clinical, the warmth comes from the type setting alone.
- **Surface** (`--surface`, `#ffffff`): same pure white. Cards in this system rarely have their own background; content lives on the canvas, separated by grid alignment rather than by surface tier.
- **Foreground** (`--fg`, `#000000`): pure black, not off-black. International typographic style demands maximum ink density.
- **Muted** (`--muted`, `#787878`): pure mid-grey for metadata, captions, the secondary "Eyebrow / Date / Issue" line. No warmth bias.
- **Border** (`--border`, `#000000`): black, used for fine 0.5–1px rule lines that mark the grid (a hairline under a column heading, a vertical rule between sections). NOT for container outlines — the grid IS the border system.
- **Accent** (`--accent`, `#d80027`): one Swiss-red. Used on the primary CTA fill, one display callout, the active state on a navigation chip, and exactly one decisive flourish per page. Alternates per artifact: cobalt blue (`#003a8c`) for cooler / corporate-academic feel, museum-yellow (`#ffcc00`) for cultural / exhibition feel. Pick ONE per page.
- **Accent hover** (`--accent-hover`, `#b80020`): darken-on-hover.
- **Accent fg** (`--accent-fg`, `#ffffff`): white on the red fill.
- **Semantic** (`--good` `#007a3d`, `--warn` `#ffcc00`, `--bad` `#d80027`): saturated, poster-style. The genre uses pure poster colors; desaturated semantics read as half-hearted.

The discipline: **one chromatic accent, used sparingly**. If a page has more than 3–4 instances of the accent, you've overused it; the accent must read as *punctuation*, not as a second neutral. The monochrome palette IS what makes the red work.

## 3. Typography rules

- **Font stack:** Helvetica Neue primary, Akzidenz Grotesk as fallback for character, Inter as universal fallback. The display face and body face are the same — that IS the genre. Switching display to a serif (or to Inter) drops you out of Swiss design.
- **Scale (px):** 11 / 13 / 15 / 18 / 24 / 36 / 56 / 84 / 120.
- **Body:** 15px (Helvetica reads larger than Inter at the same px). Weight 400 default, 700 (bold) for emphasis. Avoid 500 (medium) — Swiss design uses a clear regular/bold dichotomy, not gradient weight.
- **Display:** weight 700 (bold). Tight tracking on ≥36px: `letter-spacing: -0.015em`. At ≥84px push to `-0.025em`.
- **Line height:** 1.4 on body (clinical), 1.05 on display (Swiss display is tight, almost crowded).
- **Caps + tracking on labels.** Eyebrow labels, section markers, and "Issue 04 · Spring" lines are set in uppercase with `letter-spacing: 0.12em`. The genre uses uppercase tracked labels as a structural device.
- **Hung punctuation, optical kerning** where the type setting demands it. The system rewards detail-obsession in type.
- **Lining figures only.** Tabular nums in tables. Oldstyle figures belong to editorial-serif systems, not to Swiss.

## 4. Spacing & density

- **The 12-column grid.** This system commits hard to a 12-column grid with consistent gutters (24px on desktop). Everything sits in the grid — including margins, headings, captions. Element widths are spans (`span 4`, `span 8`, `span 12`) — never arbitrary pixels.
- **Section padding:** 96–144px vertical on desktop, 64–80px on mobile. The white space IS the breathing room; cramming sections defeats the system.
- **Component padding:** sparse. Buttons 12×20. Inputs 12×16. Cards: prefer no card, just grid-aligned content.
- **Radius:** 0px. Hard rectangles only.
- **Gutters:** 24px between columns; 8px or 16px between in-row chips.

Density runs deliberately strict — every gap is a column gap, every alignment is a grid line. If a section breaks the grid, that's an *intentional* art-direction decision (and rare), not a fallback.

## 5. Signature moves & avoid list

**The visible grid is mandatory.** During design, the 12-column grid is visibly aligned. In shipped pages, you don't draw the grid lines but the EYE can trace them — every heading start, every paragraph edge, every image left-edge falls on a grid line. The reader perceives the grid even when it's invisible. Without this rigor the system collapses to "white page with Helvetica" — a typography choice, not a design system.

**The asymmetric column composition.** Swiss design favors *asymmetric* compositions on a *symmetric* grid. A common move: a 12-column grid where the headline lives in columns 1–6, the lead in 7–11, a tiny date pinned in column 12. Another: a full-bleed image spanning columns 1–8 with a column-12 caption hanging in the margin. Asymmetry within the grid is the rhythm.

**The one decisive flourish per artifact:** in this system, the flourish is usually *one oversized display word* in the accent color (a single word from the headline rendered in red, the rest in black), *one full-bleed photographic plate* with the headline overlaid in tight kerning, or *a single bright accent rule* (a 4–6px horizontal line in the accent color between sections). Pick one.

**Avoid:**

- Warm-paper backgrounds. The canvas is pure white; warm cast reads as editorial, not Swiss.
- Serif body. Helvetica + Helvetica is the system. Mixing in Iowan / Georgia for body drops you into editorial-monocle.
- Rounded corners. Zero radius, no exceptions via token.
- Soft shadows. The system uses grid alignment for structure, not depth via shadows.
- Multiple chromatic accents. ONE accent per artifact. Red OR blue OR yellow — not two together.
- Casual body weights (300 / 500). Swiss uses 400 + 700; gradient weights read as undecided.
- Photography that's NOT documentary / architectural / artwork. Stock photography of smiling tech workers in this system breaks the brand instantly.
- Pixel-precise off-grid placement. Every dimension is a column span; "let's make this 287px wide" is wrong here. It's `span 4`, period.
- Drop caps. Swiss design doesn't drop-cap; it uses tracked uppercase labels instead.
- Marketing-warm copy voice. The visual language is austere; copy should be plain, precise, factual. "We're stoked to announce…" in this system reads as cosplay.
