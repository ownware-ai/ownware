---
name: brand-identity
description: 'Generic framework for shaping a brand identity across 5 dimensions — color tokens, type scale, voice rules, motion identity, asset system — with Ownware as the worked example. Use when a user asks "design a brand" or "what should our identity be" or hands over fragments and asks for cohesion. Skip for choosing one existing direction (use /discovery) or for tactical artifact critique (use /critique).'
trigger: /brand-identity
---

# Brand Identity — five dimensions, one identity

## Overview

A brand identity is not a logo and a color. It's five concrete dimensions, locked together: color, type, voice, motion, and asset system. This skill walks the agent through defining each one with enough specificity that any future artifact in the same brand reads as obviously from the same hand. The worked example is Ownware's own brand — use it as a model, not a template.

For picking a visual direction for a one-off artifact, use `discovery`. For tightening copy persuasion, use `psychology-applied`. This skill is for the moment a user asks "what should our brand actually be" or "we have fragments — help us make them cohere."

---

## Critical Constraints — read every time

1. **All five dimensions or none.** Skipping any one dimension produces a brand that wobbles. A locked color system with no motion identity reads like a stationery kit, not a brand.
2. **Token names are part of the identity.** Use `--cx-violet` (Ownware-specific, semantic-meaningful) or `--brand-primary` (project-specific). Don't ship raw hex outside `:root`.
3. **Voice rules need do/don't pairs and 3 sample sentences each.** Voice without examples is wishlist, not rule. Examples must be at the size the brand actually uses (headline length, body length, microcopy length).
4. **Lock the system before locking the artifacts.** Tokens go in `:root`, voice rules go in a `BRAND.md` (or similar), motion goes in a single keyframe/timing block. Then build artifacts against the locked system — never the reverse.
5. **One worked example per dimension is enough.** A 50-page brand guideline ships nothing. A 5-section locked-down system ships everything.

---

## The five dimensions

### 1. Color tokens — primary + accent + status trio

**What to define:**

- **Primary** — the dominant brand color. Used for primary CTAs, primary links, and the brand mark itself.
- **Accent** — secondary support color. Used for highlights, decorative shapes, callout backgrounds. Always paired with primary; never used alone for primary actions.
- **Status trio** — `--good`, `--warn`, `--bad`. These are not decorative; they encode meaning. Lock them early so semantic states are consistent across every artifact.
- **Neutrals** — `--bg`, `--surface`, `--fg`, `--muted`, `--border`. The chrome the brand colors sit inside. Get these wrong and the brand colors look cheap.

**How to define:**

1. Pick the primary first. Run a contrast check against white and against your `--bg`. Both should hit at least 4.5:1 for text use. If not, you need two values: a stronger `--primary` and a `--primary-on-bg` text version.
2. Pick accent in a complementary or analogous relationship to primary — not random. Use HSL: pick a hue 30–60° or 180° from the primary hue, similar saturation, similar lightness.
3. Status trio: lock greens, ambers, reds that *feel like the brand*, not generic Bootstrap colors. A serious B2B brand picks slightly desaturated, slightly darker status colors; a consumer brand picks brighter ones.
4. Neutrals: pick `--bg` first (white, off-white, or near-black). Build the rest around it.

### 2. Typography scale — display / heading / body / caption + line-heights

**What to define:**

- **Display** — heroes, the brand's loud voice. 48–96px on desktop.
- **Heading** — section titles, card titles. h1: 32–40px, h2: 24–28px, h3: 18–22px.
- **Body** — paragraph copy. 14–16px desktop, 16–18px mobile.
- **Caption** — labels, metadata, fine print. 12–13px.
- **Line-heights** per size: display 1.0–1.1, headings 1.15–1.25, body 1.5–1.6, captions 1.4.
- **Letter-spacing**: display sizes ≥32px need `-0.01em` to `-0.02em` (tight); body needs `0`; all-caps captions need `+0.05em` (loose).

**How to define:**

1. Pick ONE display font and ONE body font. That's the pairing. Don't ship three fonts unless one is a monospace for code.
2. Choose the font for the brand's voice register: serif = considered/editorial; sans = modern/utilitarian; geometric sans = tech-forward; monospace = developer-spoken.
3. Set the scale by ratio, not by guess. A ratio of 1.25 (major third) or 1.333 (perfect fourth) keeps the scale harmonious: 12 → 16 → 20 → 26 → 32 → 40 → 52 → 66 — or pick your own and stick to it.
4. Lock line-heights per size, not globally. Body at 1.5 looks great; display at 1.5 looks like a flyer.

### 3. Voice rules — do/don't pairs + 3 sample sentences

**What to define:**

- **Register** — formal vs casual vs builder-spoken vs marketing-spoken. Pick one. Stay there.
- **Point of view** — "we" vs "you" vs "the product." Pick one default and one exception case (e.g. "we" for our company stance, "you" for instructions).
- **Forbidden words list** — the marketing tics the brand never uses. "Leverage," "unlock," "supercharge," "empower," "revolutionize" — start with these and add your own.
- **Three sample sentences at each register** the brand actually writes in: a headline, a body sentence, a microcopy line (error message, empty state, button label).

**How to define:**

1. Write three landing-page headlines. Now write three more *in your voice*. Read all six. Which read as one writer? That's your voice.
2. Lock forbidden words by reading a competitor's site. Every cliché you flinch at — write it down. That's the do-not-use list.
3. For each tonal extreme (excited / serious / apologetic / instructive), write the do-version and the don't-version. The brand's voice is the do-column.

### 4. Motion identity — transition timing + ease curves

**What to define:**

- **Default ease** — one ease curve for "normal" UI transitions (hovers, fades, slides). E.g. `cubic-bezier(0.23, 1, 0.32, 1)` (smooth ease-out) — feels modern and considered.
- **Durations** — one enter duration (200ms feels right for most brands), one exit duration (140ms — exits read decisive because user already chose).
- **Acceleration vs deceleration** — `ease-out` for elements entering (they're settling); `ease-in` for elements leaving (they're departing). Asymmetry matters.
- **What animates and what doesn't** — list it. "Buttons: hover background fade 200ms. Modals: enter 200ms scale 0.95→1 + opacity. Page transitions: none." Restraint reads as a brand.
- **Reduced-motion fallback** — always. `@media (prefers-reduced-motion: reduce)` strips all non-functional motion.

**How to define:**

1. Pick the ease curve first. It's the brand's "personality" in motion. Snappy vs smooth vs bouncy.
2. Lock duration ratio: enter slightly slower than exit. 200/140 is a strong default.
3. Make a list of every animated element. If the list is longer than 10, you're animating too much.

### 5. Asset system — logo lockups + supporting marks

**What to define:**

- **Logo lockups** — the full wordmark + icon-only mark. Define when each is used (icon for favicons / app icons / dense UI; wordmark for headers, footers, business contexts).
- **Sizing rules** — minimum sizes, clear-space around the mark.
- **Color treatments** — full color on light bg, full color on dark bg, monochrome on photo, knockout (white-on-color).
- **Supporting marks** — secondary glyphs or icons that aren't the logo but read as "from this brand." Often a single chevron, arrow, or geometric shape.
- **Iconography rules** — stroke weight (1.5px / 2px), corner radius, fill vs stroke. Lock one and use it everywhere.

**How to define:**

1. The icon-only mark must work at 16px (favicon size). If it doesn't read at 16px, the mark is broken.
2. Define clear-space as a fraction of the mark's height (e.g. "1× cap-height of clear space on all sides").
3. Pick stroke weight for icons and never deviate. Mixing 1.5px and 2px stroke icons is the #1 brand-consistency tell.

---

## Worked example — Ownware's own brand

Ownware is the canonical brand built using this framework. Use it as a model.

### Color

```css
:root {
  /* Primary trio — the Ownware signature */
  --cx-violet: #7C5CFC;        /* primary — used for CTAs, focus rings, brand mark */
  --cx-violet-hover: #6748E8;
  --cx-violet-fg: #ffffff;     /* white reads cleanly on --cx-violet (4.6:1) */

  --cx-teal: #00D4AA;          /* accent — highlights, decorative shapes, success accents */
  --cx-rose: #F14060;          /* warning/destructive — used sparingly */

  /* Status trio */
  --good: #00B894;             /* slightly darker than teal for status use */
  --warn: #F2A33C;
  --bad: #F14060;              /* shares hue with --cx-rose by design */

  /* Neutrals */
  --bg: #0E0B1A;               /* deep purple-black — Ownware ships dark-first */
  --surface: #161229;
  --surface-2: #1F1A36;
  --fg: #F2F0FA;
  --muted: #9990B8;            /* contrast on --bg: 5.2:1 — passes AA */
  --border: #2A2444;
}
```

Why these: violet signals "considered, builder-tooling, not generic SaaS-blue." Teal accents read as "calm precision." Rose pulls double duty as warning and as the brand's single hot color. Dark-first because Ownware's users are agents and engineers in late-night focus modes.

### Typography

```css
:root {
  --font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
  --font-body: -apple-system, "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}

/* Scale — ratio 1.25 */
h1 { font: 700 52px/1.05 var(--font-display); letter-spacing: -0.02em; }
h2 { font: 600 36px/1.15 var(--font-display); letter-spacing: -0.015em; }
h3 { font: 600 22px/1.25 var(--font-display); letter-spacing: -0.01em; }
p  { font: 400 16px/1.55 var(--font-body); }
.caption { font: 500 13px/1.4 var(--font-body); letter-spacing: 0.02em; text-transform: uppercase; }
code, pre { font: 400 14px/1.5 var(--font-mono); }
```

Why these: Fraunces is a workhorse serif with personality — it signals "this was considered." Pairing it with system sans for body gets readability for free. Mono for code is non-negotiable in a developer-tools brand.

### Voice

**Register:** direct, builder-spoken, no marketing tics.
**POV:** "you" for instructions, "Ownware" for product capabilities, "we" only when the company speaks.
**Forbidden:** "leverage," "unlock," "supercharge," "empower," "revolutionize," "seamlessly," "powerful," "robust," "delight," "magic ✨," "AI-powered."

Sample headlines (3):

- "Run an agent on your laptop. Keep the credentials there too."
- "Connectors that connect. Threads that remember."
- "Ownware is the agent OS. You bring the goals."

Sample body sentences (3):

- "Every credential and conversation lives on infrastructure you own. There is no Ownware-hosted middleware."
- "Threads remember context across sessions. The agent picks up where it left off, with the same tool access."
- "The skill is the smallest unit of agent capability. Each one is a markdown file with explicit triggers."

Sample microcopy (3):

- Empty state: "No threads yet. Hit ⌘N to start one."
- Error: "Couldn't reach the gateway on port 17456. Is the daemon running? Try `ownware status`."
- Button: "Connect"  (not "Connect now!"). "Save"  (not "Save changes ✓").

### Motion

Default ease: `cubic-bezier(0.23, 1, 0.32, 1)`.
Enter duration: 200ms. Exit duration: 140ms.

What animates:
- Buttons: 160ms background-color fade on hover.
- Modals/drawers: enter 200ms scale 0.96→1 + opacity 0→1; exit 140ms reverse.
- Threads list: new thread fades in 200ms.
- Streaming chat tokens: no animation — they appear as the model emits them.
- Page transitions: none.

Reduced motion: every animation collapses to opacity-only at 100ms.

### Assets

Logo: the Ownware wordmark + the "tile" mark (a four-square geometric icon — represents the mosaic of agents).
Minimum sizes: wordmark 80px wide, tile mark 16px.
Clear space: 1× tile-mark height on all sides.
Stroke weight for icons: 1.5px, consistent.
Supporting glyph: the corner-arrow used for outbound links — same 1.5px stroke.

---

## Concrete examples

### Example A — A user asks "design a brand for a learning app for kids"

Apply the framework:

- **Color:** warm primary (a friendly orange, `#F47B45`), playful accent (a sky blue, `#5CC5FF`), status trio in saturated forms (`--good: #3FBC50`, `--warn: #F2C13C`, `--bad: #E94858`). Neutrals: cream `--bg: #FFF8EE`, white `--surface`, dark warm grey `--fg: #2A1F17`.
- **Type:** display in a rounded geometric (`"Fredoka", sans-serif`), body in a high-legibility sans (`"Inter"`). Larger body size for early readers (18px). Scale ratio 1.333.
- **Voice:** warm, encouraging, "we believe you can do this" — never condescending, never adult-marketing. Forbidden: "amazing!" with three exclamation marks, "you got it!" (default cheer = becomes meaningless). Sample headlines: "One word at a time." / "Today you learned 12 new words." / "Try again — you almost had it."
- **Motion:** bouncy ease (`cubic-bezier(0.34, 1.56, 0.64, 1)`), slightly longer durations (240ms) so animations land emotionally. Reduced motion strips bounce.
- **Assets:** mark is a single chunky character glyph. Icons at 2.5px stroke (chunkier reads as kid-friendly). Color treatments include a "knockout on cream" variation for stickers and printables.

### Example B — A user pastes 8 inconsistent screenshots and asks "tie this together"

Run the framework as an audit:

1. **Color audit.** Pull every hex used across the 8 screenshots. Plot them on a hue wheel. Pick 3 to keep, drop the rest. Document the drops.
2. **Type audit.** List every font and size used. There are probably 7 fonts and 14 sizes. Collapse to one display + one body + 5 sizes with locked line-heights.
3. **Voice audit.** Read every line of copy aloud. List the tonal registers present (marketing-pitch, support-apology, product-instruction, legal). Pick one as the default; rewrite the other three at the default register.
4. **Motion audit.** List every transition. Note the durations (probably 8 different values) and easings (probably 5). Collapse to one ease, two durations.
5. **Asset audit.** Are icons one weight? Probably not. Pick the most common weight, redraw the outliers.

Deliver: a single BRAND.md + tokens.css + 3 redone-screenshots showing the framework applied to the worst three offenders.

---

## Anti-patterns

- **Reaching for "let's just pick a color and write the rest later."** Stop. Color without voice is a swatch. Voice without color is a tone document. The five dimensions lock together — define them together or none cohere.
- **Reaching for a 50-page brand guideline document.** Stop. Ship a 5-section locked system: tokens.css + BRAND.md (≤500 lines covering the five dimensions). The guideline that gets read is the one that fits on a page per dimension.
- **Reaching for stock-photo "lifestyle" imagery in the asset system.** Stop. If the brand can't ship without a stock photo of hands-on-keyboard, the brand isn't done. Real photos, custom illustrations, or no imagery — pick one.
- **Reaching for "and we'll have a kids version and a serious version of the brand."** Stop. One brand. Multiple voice registers within the brand are fine; multiple visual systems are two brands wearing the same logo.
- **Reaching for a font called "Display" and a font called "Body" because that's what the inspiration site had.** Stop. Pick fonts that mean something for THIS brand. Ownware ships Fraunces because Fraunces communicates "considered serif, modern with personality" — that's the brand stance. Don't borrow the inspiration's font; borrow the inspiration's *thinking*.
