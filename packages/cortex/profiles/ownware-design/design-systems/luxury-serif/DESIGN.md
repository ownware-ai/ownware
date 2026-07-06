# Luxury Serif

> Category: premium
> Wide-tracked display serif, generous whitespace, deep oxblood on warm stone. The fashion / wine / hospitality / real-estate zone.

## 1. Visual theme & atmosphere

This is the "expensive without shouting" system. It belongs on surfaces that want to read as quietly premium — a hotel chain's website, a wine maker's cellar door page, a fashion house's lookbook, a high-end real-estate agent's listings, a private bank's institutional page, a fine-jewelry e-commerce site. The system is restrained: warm-stone background, a heavy display serif used at considered scale, oceans of whitespace, ONE deep saturated accent (oxblood by default), and as little chrome as possible. The system says *"if you have to ask, you can't afford it."*

The difference from `editorial-monocle` (sober editorial) is *aspiration*. Editorial-monocle is library-quiet — a journalist's voice. Luxury Serif is *boutique-quiet* — a maître d's voice. The difference from `magazine-poster` (dramatic editorial) is *restraint*. Magazine Poster is loud-and-art-directed; Luxury Serif is quiet-and-considered. Reach for Luxury Serif when the brief is "this should feel expensive, but never loud about it."

The genre depends on **whitespace as the structural medium**. Cramming a luxury page kills it instantly — the wealth of a luxury layout is in the empty space that surrounds each element, not in the elements themselves.

## 2. Color palette & roles

- **Background** (`--bg`, `#f1ece1`): warm stone. Reads as travertine, raw silk, oat paper. Never pure white — pure white kills the warmth that this system depends on.
- **Surface** (`--surface`, `#ffffff`): clean white card tier. Used sparingly — most of the page sits on `--bg`; `--surface` shows up only for the rare elevated card, a product photo mat, or a form panel.
- **Foreground** (`--fg`, `#1a1612`): warm near-black with a faint sepia. Pure black on warm stone reads as cold; luxury never reads as cold.
- **Muted** (`--muted`, `#7a6f60`): warm stone-grey for metadata, captions, prices when set quietly, hotel-room subtitles.
- **Border** (`--border`, `#d2c9b6`): warm hairline for the rare fine rule line. **Most "borders" in this system are actually whitespace** — gaps between sections, not lines.
- **Accent** (`--accent`, `#5e1a23`): deep oxblood. Used on the primary CTA fill, the brand mark, one decisive display element, the link color (set quietly, often with a hairline underline). Alternates per artifact: forest green (`#1f3d2c`) for hospitality / outdoors, ink navy (`#1a2a4a`) for finance / law, muted bronze (`#8a5e2f`) for jewelry / fragrance. Pick ONE per page.
- **Accent hover** (`--accent-hover`, `#491218`): darken-on-hover.
- **Accent fg** (`--accent-fg`, `#f1ece1`): the warm stone, NOT pure white, as text-on-accent. White on oxblood is the right contrast but the wrong temperature — the warm stone keeps the system unified.
- **Semantic** (`--good` `#2f6e3f`, `--warn` `#b58020`, `--bad` `#8a2a2a`): all desaturated and warm-tuned. Saturated semantic colors (#22c55e green) in this system look like a foreign system pasted in.

The discipline: **one accent, used five times per page at most**. The whole reason oxblood feels expensive is its scarcity against the warm-stone monochrome. If the accent shows up more than five times, it stops feeling decisive and starts feeling like a brand-color choice — which it isn't supposed to read as.

## 3. Typography rules

- **Font stack:** Recoleta / Fraunces / Cormorant Garamond for display (heavy / contrast serif with personality and weight), Inter for body. The display face is the brand; the body face is a quiet helper. **Don't use a serif body** — long-form luxury reading is fine in sans; only display needs the serif character.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 36 / 56 / 96 / 144.
- **Body:** 17px (slightly larger than other systems — luxury readers expect generous body). Weight 400 default, 500 for emphasis. Line height 1.6 — looser than UI-default, closer to print reading.
- **Display:** weight 500–600 (rarely 700 — heaviness reads as weight, which can drift toward magazine-poster). Tight tracking on ≥56px: `letter-spacing: -0.02em`. At ≥96px push to `-0.03em`. **Hung punctuation** on display where the layout permits.
- **Tracked-uppercase labels.** Section markers, "BY APPOINTMENT", "SS26 COLLECTION", "FOUNDED 1862" labels use uppercase with `letter-spacing: 0.18em` — that's wider than most systems' tracking, deliberately. The wide tracking telegraphs "engraved."
- **Oldstyle figures** in body prose where the typeface supports them (Fraunces does; Cormorant does); lining figures in tabular data only.
- **Drop caps allowed** for long-form essays — a 3-line oxblood-colored display-serif drop cap is the only ornament-as-text the system tolerates.

## 4. Spacing & density

- **Section padding:** 144px vertical on desktop, 96px on mobile. The luxury bar is generosity; sections that breathe less feel cramped.
- **Body column:** maximum 58–62 characters wide. Wider lines break the considered-reading feel.
- **Card / panel padding:** 40–48px. Generous; the wealth is in the space.
- **Radius:** 4px on cards, 4px on buttons, 999px on pills. Never 16+ — drifts to consumer SaaS.
- **Gutters:** 32–48px between columns. Wider than every other system in the catalog — that IS the luxury signal.

Density runs DELIBERATELY loose. If the artifact's brief is "show 80 line items of data", you've picked the wrong system; data-density and luxury fight each other.

## 5. Signature moves & avoid list

**Whitespace is the structural medium.** The hero often occupies the upper third of the viewport with the headline + lead, leaving the lower two-thirds nearly empty — sometimes with just a single product photo or quote pinned bottom-right. Sections are separated by ~144px vertical gaps rather than by visible rules. The page reads slowly.

**The one decisive flourish per artifact:** in this system, the flourish is usually *one display word in the accent* (the brand word, a key noun from the headline rendered in oxblood while the rest stays in `--fg`), *one wide-tracked uppercase eyebrow* sitting alone in the margin (a "FOUNDED 1862" or "SS26 COLLECTION" tag set at 11px with 0.24em tracking, sometimes vertically rotated), or *a single full-bleed photograph* with the headline overlaid in tight kerning. Pick one.

**The institutional footer.** Luxury sites often end with a strict, restrained footer carrying the established-year, address lines, ateliers / locations, and a sparse newsletter signup. The footer is the brand certification. Implement it as 4 columns of tracked-uppercase labels over plain links — never as a SaaS-style "Resources / Company / Legal" stack.

**Avoid:**

- Pure-white canvas. The warm stone IS the brand atmosphere.
- Geometric sans for display. Switching display from Recoleta to Inter drops the entire genre into "modern-minimal."
- Multiple chromatic accents. ONE accent, used scarcely.
- Heavy rounding. 4px is the ceiling. Pillowy radii drift into consumer.
- Drop shadows in the SaaS sense. The system uses NO shadow at all — the warmth and whitespace carry the depth.
- Hero photography of generic-corporate subjects (the smiling-stock-photo trap). The genre uses commissioned editorial photography, architecture, still life, or product-only photography. Stock people kill the brand instantly.
- Marketing-energy copy voice. "Crush your goals!" against this palette is comedy. Pair with restrained, evocative, slightly understated voice — "An atelier of fine jewelry. By appointment, since 1862."
- Cramming. The whole genre is "let it breathe." Resist the urge to add cards just because there's empty space — empty space IS the design.
- Iconography overload. Luxury uses icons sparingly — maybe a brand monogram, maybe one small directional chevron in a CTA. The Material-icon-everywhere instinct breaks the system.
- Density bars / progress indicators / status pills in the SaaS sense. Luxury isn't a status-driven system; UI chrome belongs in other systems.
