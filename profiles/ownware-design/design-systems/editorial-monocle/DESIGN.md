# Editorial Monocle

> Category: editorial
> Restrained editorial. White-space heavy, serif display, near-black-on-warm-white discipline.

## 1. Visual theme & atmosphere

The "luxury magazine" feel. This is the design system for surfaces where the reader is being asked to consider something carefully — premium consumer brands, high-end consultancies, considered-purchase marketing, art and design publications, editorial long-form. The signal is *discretion through whitespace* and *authority through typography*.

The visual vocabulary is editorial-print transplanted onto the web. A serif display face does the heavy lifting (Times, Georgia, Iowan, Fraunces). Body type is a clean sans, smaller than usual, with generous leading and narrow measure. Side margins are wide — sometimes uncomfortably wide by modern web standards — because the page is meant to read like a magazine column, not a feed.

Color is monochrome plus one near-black "accent" that isn't really an accent at all; it's the *outline weight* of an otherwise color-free surface. A real chromatic accent only appears when content forces it (a brand logo lockup, a category color in a navigation bar, an editorial photograph). Otherwise: cream, white, black. Three values.

This system is the right answer when:

- The user names "luxury", "considered", "magazine", "editorial", "premium".
- The artifact is meant to read slowly. Sales pages with three CTAs above the fold are the wrong fit.
- The audience is senior and self-selecting. Investors, executives, considered consumers.

## 2. Color palette & roles

- **Background** (`--bg`, `#fafaf7`): warm off-white, ever so slightly cream. Reads as paper.
- **Surface** (`--surface`, `#ffffff`): cards, pull quotes, photo wells. Pure white earns the contrast.
- **Foreground** (`--fg`, `#1a1a1a`): primary text. Near-black, warm-leaning. Pure `#000` is too sharp against `--bg`.
- **Muted** (`--muted`, `#6b6b6b`): captions, byline, footer copy.
- **Border** (`--border`, `#e8e6e0`): hairline rules, often replaced by whitespace alone.
- **Accent** (`--accent`, `#1a1a1a`): in this system, the "accent" is the same near-black as `--fg`. A primary CTA is a black box with white text. A secondary CTA is a black-bordered text link. This is the discipline.
- **Accent fg** (`--accent-fg`, `#ffffff`): white text/icons on the near-black filled buttons.
- **Semantic** (`--good` `#2f7d4a`, `--bad` `#b53a2a`): used only when content demands. Both run a half-step warmer than typical to match the warm-white surface ladder.

If the brand demands a chromatic accent (e.g. a single brand color on a logo), introduce a `--accent-warm` or `--accent-cool` as an additional token, but **do not replace** the near-black accent — the system's identity depends on it.

## 3. Typography rules

- **Display:** serif. `"Times New Roman", Georgia, "Iowan Old Style", "Hoefler Text", serif`. For premium feel: `"Fraunces"` or `"Newsreader"` via Google Fonts.
- **Body:** sans. `-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif`. Smaller than typical web body — 15px on desktop, 14px on mobile. The system reads "magazine column", not "marketing landing page."
- **Mono:** `ui-monospace, 'JetBrains Mono', Menlo, monospace`. Used for figures and footnotes only.
- **Scale (px):** 12 / 14 / 15 / 16 / 18 / 24 / 32 / 48 / 72 / 96. The big steps matter — `48 → 72 → 96` for cover-style display.
- **Line height:** 1.6 on body (generous, magazine-like), 1.1 on display, 1.25 on subheads.
- **Letter-spacing:** `-0.01em` on display ≥32px, `-0.02em` on ≥72px.
- **text-wrap:** `pretty` on body, `balance` on h1 / h2.
- **Measure:** body column max-width 64ch on desktop, 90% on mobile. Wider than that breaks readability.

## 4. Spacing & density

- **Section padding:** 120px vertical on desktop, 72px on mobile. The whitespace **is** the design.
- **Side margins:** desktop body column inset 8–12vw from the edges. Mobile 4vw.
- **Component padding:** cards 24–32px, buttons 14×24, inputs 12×16.
- **Radius:** 4px. Editorial-print rarely rounds; we permit just enough to read as web rather than newsprint.
- **Pills:** 999px, but used sparingly — pills look anti-editorial. Prefer flat-bottom rectangular tags.
- **Gutters between editorial blocks:** 48–72px. Wider than feels "necessary" — that's the point.

## 5. Signature moves & avoid list

**The one decisive flourish per artifact:** in this system, the flourish is *the typography itself*. A single oversized display headline (72–120px) on the hero, set in serif, with `text-wrap: balance` doing the heavy lifting. Or a single drop cap on the opening paragraph. Or a single full-bleed photograph with a generous caption beneath. One moment, executed well.

**Avoid:**

- Multiple display fonts. One serif. Period.
- Gradient anything. The system is flat and printed-paper-like.
- Heavy shadows. None. Editorial surfaces sit flat on the page.
- Bright accent colors. The whole system is monochrome by design.
- Generic stock photography. Editorial systems demand considered imagery; a generic gradient hero illustration is worse than nothing.
- Inter / Helvetica everywhere. The serif display is the identity; reaching for an all-sans treatment converts this back into `modern-minimal`.
- More than one CTA above the fold. Editorial pages ask the reader to consider; multiple competing actions undercut the consideration.
- Pill-shaped buttons everywhere. Rectangular with a small radius (4–6px) reads more editorial than capsule.
