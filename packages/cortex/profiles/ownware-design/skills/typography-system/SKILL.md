---
name: typography-system
description: 'Build a modular type scale, pick a pairing, set vertical rhythm + line-length + x-height balance — the type system any artifact stands on. Use when starting a new system, when copy reads cramped or noisy, or when headlines and body feel from different families. Pairs with /color-system (token discipline) and /artifact (where the tokens live). Skip when the user said "make the headline bigger" — that''s a one-token swap, not a system.'
trigger: /typography-system
---

# Typography System — modular scale, considered pairing, real rhythm

## Overview

Type is the foundation. Pick the wrong base size, the wrong ratio, the wrong line-height, and every section reads "AI-generated" before the user can articulate why. Pick them right — once, deliberately — and every heading, label, and paragraph in the artifact inherits the same skeleton.

This skill produces five artifacts: (1) a base size, (2) a modular ratio, (3) a 5-7 step ramp, (4) a pairing decision (one family / two / display+body), (5) per-role line-height + letter-spacing. Every value lands in `:root` as a token.

Use this when building a system from zero, when the type feels wrong across multiple sections (rhythm problem, not size problem), or when the user has named a feel ("editorial", "dashboard density", "premium") and you need to translate it to numbers. Don't use this for single-element tweaks — surgical edit a `font-size` and move on.

---

## Critical Constraints

1. **Base size is 16px unless you have a reason.** iOS Safari zooms inputs below 16px on focus — body type smaller than 16px breaks tap targets and reads childish. Editorial long-form can lift to 18px; dense dashboards can drop to 14px ONLY for tabular data, never for the main body.
2. **Pick one ratio. Use it. Stop bargaining.** Mixing 1.2 for some steps and 1.333 for others produces a ramp that wobbles. The whole point of a modular scale is geometric coherence — one ratio, ramp ascends.
3. **At most two families per artifact.** Three families is a smell. Display + body covers 99% of cases. Mono is a third only when literal code or data appears — never for "decoration."
4. **Line-height is per role, not global.** Body 1.5-1.65. Headings 1.05-1.2. Labels and caps 1.1-1.3. One global `line-height: 1.5` on `body` cramps headings and inflates labels.
5. **Letter-spacing scales inversely with size.** Display sizes (≥ 32px) want negative tracking (`-0.01em` to `-0.03em`). Body wants 0. Small caps and labels want positive tracking (`+0.05em` to `+0.10em`).
6. **Measure (line-length) is sacred.** Body paragraphs: 45-75 characters per line. Past 75 the eye loses the next line; under 45 it ping-pongs. Use `max-width: 65ch` as the default for prose.

---

## Framework — the five steps

### Step 1 — Pick the base size (3 choices)

| Base | Use case | Note |
|------|----------|------|
| **14px** | Dense dashboards, terminals, admin UIs — tabular data only | The body still wants 15-16px. 14px is for table cells, KPI labels, monospace columns. |
| **16px** | Default for marketing, product UIs, most landings | The honest choice for 90% of artifacts. |
| **18px** | Long-form editorial, magazine layouts, premium content | Pairs with serif body; lifts comfort on column widths > 60ch. |

### Step 2 — Pick the modular ratio (5 choices)

The ratio multiplies each step. Pick once; never mix.

| Ratio | Name | Vibe | When to use |
|-------|------|------|-------------|
| **1.125** | Minor second | Compact, tight | Dashboards, admin tools, dense reference UIs. h1 sits close to body. |
| **1.200** | Minor third | Moderate, balanced | Default for B2B SaaS. Reasonable hierarchy without drama. |
| **1.250** | Major third | Confident, product-grade | Marketing pages, landings. The Stripe/Linear zone. |
| **1.333** | Perfect fourth | Dramatic, editorial | Long-form articles, magazines, premium brand pages. Big h1 contrast. |
| **1.500** | Perfect fifth | Bold, expressive | Brutalist, agency, fashion. h1 is 5-6x body. Use deliberately. |

Math: each step = `base × ratio^n`. For an 8-step ramp at ratio 1.333, the top is `16 × 1.333^7 ≈ 99px`. Round to clean values (96, 100) — the user reads the rendered px, not the math.

### Step 3 — Build the 7-step ramp

Standard role mapping (16px base):

| Token | Role | 1.125 | 1.200 | 1.250 | 1.333 | 1.500 |
|-------|------|-------|-------|-------|-------|-------|
| `--text-xs` | micro labels, captions | 12 | 12 | 12 | 12 | 11 |
| `--text-sm` | secondary, footnotes | 14 | 14 | 14 | 14 | 13 |
| `--text-base` | body | 16 | 16 | 16 | 16 | 16 |
| `--text-lg` | lead paragraph | 18 | 19 | 20 | 21 | 24 |
| `--text-xl` | h3, card title | 20 | 23 | 25 | 28 | 36 |
| `--text-2xl` | h2, section heading | 23 | 28 | 31 | 38 | 54 |
| `--text-3xl` | h1, page title | 25 | 33 | 39 | 51 | 81 |
| `--text-4xl` | hero | 28 | 40 | 49 | 67 | 121 |

For hero on marketing, use `clamp()` fluid sizing instead of a fixed step — see Example 1.

### Step 4 — Pick the pairing

Three legal patterns. Never four families. Never three "decorative" choices.

**Pattern A — One family, varied weight.** The boring, reliable pick. Inter or system-ui at 400 for body, 600 for h3/h2, 700 for h1. Works for B2B, product UIs, dashboards. Risk: feels generic if the brand is supposed to be opinionated.

**Pattern B — Display sans + body sans.** Two sans families with distinct personalities. Display gets a geometric or expressive face (Söhne, Inter Display, Switzer, Manrope) at 600-700. Body gets a workhorse (Inter, system-ui, IBM Plex Sans) at 400-500. Works for product brands that want one moment of personality (h1, hero) without sacrificing readability.

**Pattern C — Display serif + body sans.** Editorial, premium, magazine. Serif handles display (Fraunces, Tiempos, Iowan Old Style, Times) at 500-600. Sans handles body (Inter, system-ui). Works for content-heavy artifacts, brand pages, premium SaaS landing pages. Risk: serifs at small sizes (<18px body) read dated — keep serifs in display only unless you specifically want long-form serif body.

**Forbidden:** display serif + body serif (illegible at body sizes), three families, "decorative" cursive anywhere outside an explicit brand mark.

### Step 5 — Set per-role line-height + letter-spacing

```css
:root {
  --leading-tight:    1.1;   /* hero h1, large display */
  --leading-snug:     1.2;   /* h2, h3 */
  --leading-normal:   1.5;   /* body */
  --leading-relaxed:  1.65;  /* long-form body (editorial) */
  --leading-loose:    1.8;   /* rare — quotes, pull-outs */

  --tracking-tightest: -0.03em; /* hero ≥ 64px */
  --tracking-tighter:  -0.02em; /* h1 (40-60px) */
  --tracking-tight:    -0.01em; /* h2, h3 (24-40px) */
  --tracking-normal:   0;       /* body */
  --tracking-wide:     0.05em;  /* labels, small caps */
  --tracking-wider:    0.10em;  /* all-caps section labels */
}

h1 { font-size: var(--text-4xl); line-height: var(--leading-tight); letter-spacing: var(--tracking-tighter); text-wrap: balance; }
h2 { font-size: var(--text-2xl); line-height: var(--leading-snug); letter-spacing: var(--tracking-tight); text-wrap: balance; }
h3 { font-size: var(--text-xl); line-height: var(--leading-snug); letter-spacing: var(--tracking-tight); }
body { font-size: var(--text-base); line-height: var(--leading-normal); letter-spacing: var(--tracking-normal); }
p { max-width: 65ch; text-wrap: pretty; }
.label-caps { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: var(--tracking-wider); }
```

---

## Concrete examples

### Example 1 — Editorial magazine layout (1.333 ratio, serif display + sans body)

**Brief:** Long-form article, premium feel, h1 must feel dramatic without shouting.

```css
:root {
  --font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
  --font-body:    "Inter", -apple-system, system-ui, sans-serif;

  --text-xs:   12px;
  --text-sm:   14px;
  --text-base: 18px;        /* lifted base for long-form */
  --text-lg:   24px;        /* lead */
  --text-xl:   32px;        /* h3 */
  --text-2xl:  43px;        /* h2 */
  --text-3xl:  57px;        /* h1 */
  --text-hero: clamp(64px, 9vw, 96px);  /* fluid hero */

  --leading-tight: 1.05;
  --leading-snug:  1.15;
  --leading-relaxed: 1.65;  /* body — editorial wants air */
}

h1 {
  font-family: var(--font-display);
  font-size: var(--text-hero);
  font-weight: 500;
  line-height: var(--leading-tight);
  letter-spacing: -0.025em;
  text-wrap: balance;
  max-width: 16ch;
}
.article-body p {
  font-family: var(--font-body);
  font-size: var(--text-base);  /* 18px */
  line-height: var(--leading-relaxed);  /* 1.65 */
  max-width: 65ch;
  text-wrap: pretty;
}
```

Why it works: ratio 1.333 makes h1 (~57px) feel 3× body (18px) — dramatic but not unhinged. Serif display + sans body is the magazine pairing. `max-width: 16ch` on h1 prevents 80-char headlines wrapping into 4 lines. `text-wrap: balance` keeps the two-line break visually even.

### Example 2 — Dense dashboard (1.125 ratio, single sans family)

**Brief:** Observability dashboard. Lots of tables, KPI cards, charts. Hierarchy needs to read at a glance without burning vertical space.

```css
:root {
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;

  --text-xs:   11px;
  --text-sm:   13px;
  --text-base: 14px;        /* dense, but still legible */
  --text-lg:   16px;        /* sidebar h, card title */
  --text-xl:   18px;        /* panel heading */
  --text-2xl:  20px;        /* page heading */
  --text-3xl:  24px;        /* dashboard h1 — small, compact */
  --text-kpi:  32px;        /* THE outlier — KPI numbers earn it */

  --leading-tight:  1.15;
  --leading-snug:   1.25;
  --leading-normal: 1.45;   /* tighter body — density */
  --leading-table:  1.35;
}

h1 { font-size: var(--text-3xl); font-weight: 600; line-height: var(--leading-tight); letter-spacing: -0.01em; }
.panel-title { font-size: var(--text-xl); font-weight: 600; }
.card-title  { font-size: var(--text-lg); font-weight: 600; }
.kpi-number  { font-size: var(--text-kpi); font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.kpi-label   { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.table       { font-size: var(--text-sm); line-height: var(--leading-table); font-variant-numeric: tabular-nums; }
.cell-mono   { font-family: var(--font-mono); font-size: var(--text-sm); }
```

Why it works: ratio 1.125 keeps the ramp compact — every step is +12.5%, so h1 at 24px is only ~70% larger than body at 14px. KPI number is the deliberate outlier (32px) — the dashboard's "hero," the number the user came to read. `font-variant-numeric: tabular-nums` is non-negotiable on dashboards: it aligns digits vertically across rows. Without it `1,234` and `1,567` jitter.

---

## Anti-patterns

- **Ratio shopping mid-build.** "I'll use 1.25 for the ramp, but bump h1 to 1.333 because it looks small" — stop. That's not a ramp anymore; that's two ramps glued together. Either commit to the bigger ratio or accept the h1 size the math gave you.
- **Body line-height at 1.0 or 1.8.** 1.0 reads cramped, like the lines are stacked. 1.8 reads airy, like a children's book. The range is 1.5-1.65. Pick.
- **Display fonts at body size.** Loading Fraunces 700 for a 14px label is bandwidth waste and the font wasn't drawn for that size — it falls apart. Display fonts work ≥ 24px. Body fonts work 14-22px.
- **All-caps body copy.** Reads as shouting AND tracking-spaced caps lose word-shape recognition (the eye reads words as shapes, not letters). All-caps belongs in labels (`--text-xs` or `--text-sm`), never in paragraphs.
- **Three or more families.** A landing page with Inter for nav, Fraunces for hero, Söhne for cards, JetBrains Mono for code = four families = file size bloat and visual incoherence. Two is the cap. Mono earns a third only on technical content.
- **`text-wrap: balance` on body paragraphs.** It's expensive at long lengths and changes nothing readable. `balance` is for h1/h2 (1-3 lines). `pretty` is for body (avoids orphans on the last line). Use both, on the right element.
- **Hardcoded font-sizes in component CSS.** `.hero h1 { font-size: 56px; }` outside the `:root` token block — stop. The token discipline (Principle 22 vibes: one canonical home per concept) means every type size lives in `:root` and components reference `var(--text-3xl)`. One place to change the ramp.
