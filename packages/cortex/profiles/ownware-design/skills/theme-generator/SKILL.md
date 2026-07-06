---
name: theme-generator
description: 'Synthesize a complete, named theme — palette + type stack + density rule + radii — from a brief or a brand keyword, ready to paste into an artifact :root block. Use when the catalog has no good match AND the discovery inline fallback (Modern Minimal / Editorial Monocle / etc.) is too far from what the user described. Do NOT use if list_design_systems returned a good match — apply that instead. Do NOT use to overwrite an existing applied design system.'
trigger: /theme-generator
---

# Theme Generator — synthesize a coherent token block from scratch

## Overview

The catalog (`list_design_systems` + `apply_design_system`) is the primary source. Discovery's inline fallback (Modern Minimal, Editorial Monocle, Warm Soft, Tech Utility, Brutalist Experimental) covers most catalog misses. This skill is the third-line fallback: a brief or keyword so specific that neither the catalog nor an inline direction covers it ("Notion but for kids", "Bloomberg terminal × Tokyo subway map", "the new Threads but warmer").

The output is a fully-formed theme — name, palette (7–9 tokens), type stack (3 font roles), radii, density rule — paste-ready into an artifact's `:root` block. The deliverable is the CSS plus a one-paragraph rationale.

---

## Critical Constraints

1. **Use `list_design_systems` FIRST.** Always. Even if you think the catalog has nothing. The reflex of "I'll just synthesize" is the wrong default — a catalog match anchors the artifact to a coherent system someone else already pressure-tested.
2. **Synthesize ONE theme, not three.** Three options force the user to pick; this skill is the "we already picked" path. If the user wants three, that's `/ideate-concepts` upstream.
3. **Every theme has a name in two words.** "Coastal Modernist", "Subway Bloomberg", "Threadsy Warm". Naming forces clarity — if you can't name it in two words, the theme is mush.
4. **Lock the palette to 7–9 tokens.** Fewer than 7 means you missed a semantic state (`--good`, `--bad`, `--warn`). More than 9 means you're hoarding hexes that nothing references.
5. **Lock the type stack to 3 roles.** `--font-display`, `--font-body`, `--font-mono`. No more. Two roles is fine if display = body. Four means you're indulging.
6. **Use real, available fonts.** System fonts (`-apple-system`, `Inter`, `system-ui`), Google Fonts you can name (`Fraunces`, `Space Grotesk`, `IBM Plex Sans`, `Instrument Serif`), web-safe fallbacks (`Georgia`, `Helvetica Neue`). Never name a paid font without saying "fallback: X" right after.
7. **State density in one sentence.** "Component padding 16–24px, section padding 64–96px, line-height 1.5 body / 1.2 headings." Density is non-negotiable — leaving it implicit produces inconsistent artifacts downstream.

---

## The Framework — 5 ingredients to derive from the brief

For any brief, extract these five before writing the CSS:

### 1. Mood word (one)

The single adjective that has to be felt. "Sharp." "Warm." "Heavy." "Hushed." Not two adjectives. One. This anchors the whole theme. If you can't pick one, the brief is too thin — ask the user.

### 2. Dominant hue family (one)

Cool blue / warm orange / forest green / neutral gray / hot magenta. The accent's *family*, not the exact hex. Specific hex comes after.

### 3. Type axis (one of three)

Pick one:
- **Sans-throughout** — body and display both sans. Modern, neutral, B2B-default. Inter, IBM Plex, Space Grotesk.
- **Serif display / sans body** — editorial, premium, considered. Fraunces, Instrument Serif, Playfair on display; Inter on body.
- **Mono signature** — a deliberate mono role beyond just code. Often paired with sans body; mono carries numerals, captions, or a single hero element. JetBrains Mono, IBM Plex Mono.

### 4. Density tier (one of three)

- **Generous** — 24–32px component padding, 96–128px section padding. Editorial, premium, "luxury magazine" energy.
- **Medium** — 16–24px component padding, 64–96px section padding. Modern product default. 95% of B2B SaaS lives here.
- **Tight** — 8–14px component padding, 32–48px section padding. Operator tools, dashboards, info-dense terminals.

### 5. Radius signature (one of three)

- **Sharp (0–2px)** — brutalist, editorial, technical. Communicates seriousness.
- **Friendly (8–14px)** — modern, approachable, default-modern. Communicates competence.
- **Pillowy (16–24px)** — consumer-soft, warm, "for humans." Communicates comfort.

Pick exactly one from each of the five. Now write the CSS.

---

## The output shape

Every generated theme returns three things, in this order.

**1. The name + the mood word + the rationale (one paragraph).**

> **Coastal Modernist** — "hushed". The brief reads as a premium financial product for older affluent buyers; coastal modernist gives us the muted blue-grey of a Maine fog, restrained type, generous breathing room. Sharp radii and a single ink accent reinforce "we take this seriously."

**2. The full `:root` block, paste-ready.**

```css
:root {
  /* surfaces */
  --bg: #f4f5f6;
  --surface: #ffffff;
  --fg: #14202a;
  --muted: #5b6b78;
  --border: #d8dde2;

  /* accent + states */
  --accent: #1f3a5f;       /* coastal ink */
  --accent-hover: #14283f;
  --accent-fg: #ffffff;
  --good: #2f7d4a;
  --warn: #c98b1a;
  --bad: #b53a2a;

  /* shape */
  --radius: 2px;
  --radius-pill: 999px;

  /* type */
  --font-display: "Instrument Serif", "Iowan Old Style", Georgia, serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

**3. The density + craft rule (two lines).**

> Density: generous. Component padding 24–28px, section padding 96–128px. Line-height 1.55 body / 1.15 display.
> Craft: `text-wrap: balance` on h1/h2; `letter-spacing: -0.015em` on display ≥ 40px; `:focus-visible` outline uses `--accent`.

That's the whole deliverable. Hand off to `/artifact` for the file.

---

## Concrete examples

### Example A — "Notion but for kids" (consumer ed product)

Brief decomposition:
- Mood: **playful** (one word: playful).
- Hue family: **warm yellow + soft purple**.
- Type axis: **sans-throughout** (sans display for friendliness; serif would read too grown-up).
- Density: **medium**.
- Radius: **pillowy** (16–24px, this is the whole point).

Output:

> **Crayon Workspace** — "playful". A note-taking-for-kids product needs the workspace energy of Notion (clean canvas, restrained chrome) but with the radii and color of a school art room. Yellow primary, purple secondary, big rounded corners, bouncy display type.

```css
:root {
  --bg: #fffbf2;
  --surface: #ffffff;
  --fg: #1d1a30;
  --muted: #6b6480;
  --border: #efe9d8;

  --accent: #ffcc1a;       /* school bus yellow */
  --accent-hover: #f0bd00;
  --accent-fg: #1d1a30;
  --secondary: #8b5cf6;    /* friendly purple */
  --good: #2f7d4a;
  --warn: #d97706;
  --bad: #dc2626;

  --radius: 20px;
  --radius-pill: 999px;

  --font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
  --font-body: "Nunito", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

> Density: medium. Component padding 18–22px, section padding 64–96px. Line-height 1.6 body / 1.2 display.
> Craft: oversized button hit areas (52px min); display headlines use `text-wrap: balance` and a 1.1 line-height; hover states animate radius by 2px for "squish".

### Example B — "Bloomberg terminal × Tokyo subway map" (ops dashboard)

Brief decomposition:
- Mood: **dense** (one word: dense).
- Hue family: **near-black background + multi-line accents** (Tokyo subway gives us several named line colors).
- Type axis: **sans + mono signature** (numerals must be mono; chrome stays sans).
- Density: **tight**.
- Radius: **sharp** (0–2px; subway-map energy).

Output:

> **Subway Bloomberg** — "dense". An ops dashboard that has to render hundreds of values without exhaustion needs Bloomberg's tight terminal density, but with named accent colors mapped to data lines the way the Tokyo subway map uses named-line colors. Six accent colors, each named for the line role it plays.

```css
:root {
  --bg: #0b0d10;
  --surface: #13171c;
  --surface-2: #1a2028;
  --fg: #e6edf3;
  --muted: #8b949e;
  --border: #2a3038;

  /* line accents (named like subway lines) */
  --accent: #4ea1ff;       /* primary "JR Yamanote" blue */
  --accent-fg: #0b0d10;
  --line-marunouchi: #ed3c3a;   /* red */
  --line-ginza: #f49c1a;        /* orange */
  --line-chiyoda: #2f9e57;      /* green */
  --line-hibiya: #b0b1b3;       /* silver */

  --good: #3fb950;
  --warn: #d29922;
  --bad: #f85149;

  --radius: 0px;
  --radius-pill: 0px;

  --font-display: "IBM Plex Sans", -apple-system, system-ui, sans-serif;
  --font-body: "IBM Plex Sans", -apple-system, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

> Density: tight. Component padding 8–12px, section padding 24–40px. Numerals + tabular columns use `--font-mono` at tabular-nums.
> Craft: every data row carries its line-color as a 2px left border; hover reveals a 1px right border in the same color; focus-ring is a 2px solid `--accent` with zero offset.

---

## Anti-patterns

If you find yourself naming a theme with three words, stop. Cut to two. "Coastal Modernist Premium" is mush; "Coastal Modernist" sells the room.

If you find yourself with 12 tokens in the palette, stop. You're hoarding. Cut to 7–9. The downstream artifact will not reference `--accent-3` — it will silently fall back to whatever it had.

If your palette has zero `--good` / `--warn` / `--bad`, stop. Semantic states ship in every artifact. Always include them, even if the theme is "minimal."

If you reach for Helvetica Neue as a display font without naming a Google Font alternative, stop. Helvetica Neue is macOS-only; the artifact will render in Arial on Windows and look broken. Always pair with a web-safe fallback chain.

If the brief is generic ("modern SaaS", "clean B2B"), do not use this skill. Go back to discovery's inline fallback — Modern Minimal already exists, pre-tuned, and is better than anything you'll synthesize from "modern SaaS." This skill earns its existence on weird briefs, not safe ones.

If after extracting the 5 ingredients you find two of them contradict ("dense" + "pillowy radius", "playful" + "sharp radius"), stop and pick one. Theme coherence comes from those 5 ingredients aligning; if they fight each other, the artifact will fight itself.
