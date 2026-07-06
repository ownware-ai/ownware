# Luminous Glass

> Category: ambient
> Frosted dark panels over a gradient floor. The AI-product / music-app / immersive-tool zone.

## 1. Visual theme & atmosphere

This is the "quietly luminous" system. It belongs on surfaces where the product itself is the spectacle — an AI agent thinking out loud, an audio waveform breathing, a 3D model rotating, a chat that reads back streaming text. The chrome should fade and the content should glow. Panels float as frosted glass over an ambient gradient floor; borders are barely-there alpha lines; the one accent is a violet that earns its keep on the CTA and the focus ring and nowhere else.

The difference from `tech-utility` (dark dev tools) is intent. Tech-utility is engineered — gridlines, dense numerics, monospace. Luminous Glass is *atmospheric* — soft radial gradients on the floor, generous radii, plenty of vertical breath. Reach for this when the artifact's job is to feel ambient, not to display a lot of numbers.

The genre depends on a non-flat background. **A flat #0b0f1a body kills the glass effect** — the panels read as muddy grey, not translucent. Always paint a radial-gradient floor (two soft violet/teal stops at opposite corners, fading to the base) under the body. The tokens assume this; the components reference fixture demonstrates it.

## 2. Color palette & roles

- **Background** (`--bg`, `#0b0f1a`): the deep ink floor. Never used flat — always overlaid with a soft radial gradient (see Signature Moves).
- **Surface** (`--surface`, `rgba(255,255,255,0.06)`): the glass panel fill. Translucent white on dark; depends on the gradient floor showing through.
- **Foreground** (`--fg`, `#f5f7ff`): near-white with a barely-cool cast. Body text and the rare display element.
- **Muted** (`--muted`, `#8a93b0`): secondary text, metadata, captions. Cool grey-blue.
- **Border** (`--border`, `rgba(255,255,255,0.10)`): translucent hairline. A solid `#2a…` border kills the glass effect; keep the alpha.
- **Accent** (`--accent`, `#7c5cfc`): one violet, used on the primary CTA fill, the focus ring, the link underline, and one decisive hero element. Never a second accent in the interactive layer.
- **Accent hover** (`--accent-hover`, `#8e72ff`): lighten-on-hover. The system reads as luminous, so a darken-on-hover (used in flat-light systems) feels wrong here — the button should lift, not dim.
- **Accent fg** (`--accent-fg`, `#ffffff`): pure white on the violet fill.
- **Semantic** (`--good` `#4ade80`, `--warn` `#fbbf24`, `--bad` `#fb7185`): each one a soft, slightly-desaturated step. Avoid CRT-bright semantic colors in this system — they break the ambient feel.

The discipline: **the violet is the only chromatic interactive color**. The genre tolerates a SECOND chromatic note only as a gradient stop on the background floor (e.g. a teal radial at top-right paired with the violet at top-left) — never as a second interactive color. Two interactive accents read as a regular dark theme with extra chrome, not as Luminous Glass.

## 3. Typography rules

- **Font stack:** Inter for both display and body. The system gets its identity from light and surface, not from typeface; reaching for Manrope or Geist drifts into "regular SaaS dark theme" territory.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 36 / 56 / 80.
- **Body:** 15–16px on marketing, 14px on dense UI. Weight 400 default, 500 for emphasis. Body text sits at `--fg` (near-white) — going to `--muted` for body undersells the contrast we worked for.
- **Display:** weight 600. Tight tracking on ≥36px: `letter-spacing: -0.02em`. Tighter on ≥56px: `-0.025em`.
- **Line height:** 1.5 on body, 1.15 on display.
- **text-wrap:** `pretty` on `<p>`, `balance` on h1 / h2.
- **No mono in body chrome.** Mono is for code blocks and the rare token-style chip; don't let monospace bleed into nav, labels, or captions. The system reads as ambient, not as a terminal.

## 4. Spacing & density

- **Section padding:** 96px vertical on desktop, 60px on mobile. The system breathes — cramped Luminous Glass reads as "regular dark theme."
- **Panel padding:** 24–32px inside glass panels. Generous; the panel's job is to feel like a window, not a box.
- **Radius:** 16px on cards and buttons. 999px on pills. Smaller radii (4–8px) read as a regular dark theme, not glass.
- **Gutters:** 24px between cards in a grid. 12px between in-row chips.

Density runs medium-loose throughout. This is not a dense-numerics system; if the artifact's brief is "show 80 rows of data", you've picked the wrong system — use `tech-utility` instead.

## 5. Signature moves & avoid list

**The gradient floor is mandatory.** The first thing the agent paints inside `<body>` (or the page-wrapping element) is a multi-stop radial gradient that establishes the ambient base. A canonical version:

```css
body {
  background:
    radial-gradient(circle at 15% 10%, rgba(124, 92, 252, 0.28), transparent 38%),
    radial-gradient(circle at 85% 0%, rgba(45, 212, 191, 0.18), transparent 42%),
    var(--bg);
}
```

Two soft stops, opposite corners, generous transparent falloff. Without this, the glass panels have nothing to refract — the system collapses to a flat dark theme.

**The one decisive flourish per artifact:** in this system, the flourish is usually *the hero panel breathing* (a slow 6–8s opacity drift on the radial gradient stops), *a single oversized neon-violet glow* under a hero number or quote, or *one wide pill button* with `backdrop-filter: blur(20px)` that floats convincingly over the gradient. Pick one per page; layering all three reads as a screensaver.

**Avoid:**

- A flat dark background. Without a gradient floor, this isn't Luminous Glass — it's a dark theme.
- Solid hairline borders. `border: 1px solid #2a…` kills the glass effect. Keep the `rgba(255,255,255,0.10)` alpha.
- Hard shadows. Glass panels don't drop hard rectangular shadows; they emit a soft violet bloom. Reach for `box-shadow: 0 24px 80px rgba(124, 92, 252, 0.18)` patterns, not the standard "0 4px 12px black" SaaS shadow.
- Second interactive accent. One violet. Add a teal note ONLY as a gradient stop on the floor, never on a button.
- Tight radii. 4–8px reads as a regular dark theme; the genre needs 12–24px corners.
- Monospace creeping into nav / labels / captions. That's `tech-utility` territory; this system reads as ambient.
- Heavy gradient panels (panel fills that are gradients themselves). The PANELS are flat-translucent; the GRADIENT lives on the floor.
