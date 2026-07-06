# Neon Arcade

> Category: futuristic
> Cyberpunk neon — magenta + cyan on purple-black, glowing strokes, gradient panels, scanline texture. The game / web3 / music-drop / retro-future zone.

## 1. Visual theme & atmosphere

This is the "CRT after dark" system. It belongs on surfaces that want to read as game, club night, web3 drop, music-label release, retro-future fan project — anything where the brand should feel saturated and electric and a little overwhelming. Magenta glows off a purple-black floor. Cyan strokes outline panels. Gradients between the two carry hero typography. The genre is loud on purpose; restraint here reads as a failed Neon Arcade, not as a tasteful one.

The difference from `terminal-grid` (sober HUD / dev console) is mood. Terminal-grid is *operational* — engineers running real telemetry. Neon Arcade is *entertainment* — a stage for play, drama, atmosphere. The difference from `luminous-glass` is saturation. Luminous Glass is *ambient*, soft, quiet. Neon Arcade is *electric*, hard-edged, loud. Reach for Neon Arcade when the brief is "this is a drop / a release / a game / a party" — and reach for the others when the brief is anything calmer.

This is the second system in the catalog (alongside `playful-pop`) that allows TWO interactive accents — magenta as primary, cyan as secondary. The pairing is the visual signature; one alone collapses the genre.

## 2. Color palette & roles

- **Background** (`--bg`, `#0a0518`): near-black with a purple bias. Pure black reads as terminal-grid; the purple cast is what makes the system read as neon rather than as tech.
- **Surface** (`--surface`, `#170c2e`): deep violet panels — not neutral grey. Panels are deliberately tinted; the genre lives in saturated darkness.
- **Foreground** (`--fg`, `#ecf0ff`): cool near-white with a faint violet cast. High contrast on the dark surfaces.
- **Muted** (`--muted`, `#7a6aa8`): muted lavender for metadata. Stays in the cool-violet family so secondary text doesn't break the chord.
- **Border** (`--border`, `#34234d`): saturated violet, used VISIBLY on panel edges — often paired with a glow shadow (`box-shadow: 0 0 16px var(--accent)`) so the border itself reads as a light source.
- **Accent** (`--accent`, `#ff2bd6`): magenta. Primary CTA fill, primary glow, hero gradient stop A.
- **Accent hover** (`--accent-hover`, `#ff52e0`): lighten-on-hover — buttons glow more, not dim. Darkening a neon accent reads as "the light went out."
- **Accent fg** (`--accent-fg`, `#0a0518`): the deep purple-black as text-on-accent. White on magenta is low-contrast.
- **Accent alt** (`--accent-alt`, `#1ee9ff`): cyan. The secondary fill option, the second gradient stop, the alternating row highlight.
- **Accent alt fg** (`--accent-alt-fg`, `#0a0518`): same deep purple-black.
- **Semantic** (`--good` `#21f5a1`, `--warn` `#ffcc1e`, `--bad` `#ff5470`): CRT-saturated, intentionally loud. Desaturated semantic colors in this system read as broken.

The discipline: **magenta + cyan ONLY**. A third interactive chromatic accent (green button, yellow link) collapses the system into "generic dark theme with too many colors." Decorative shapes outside the interactive layer may use additional saturated colors (a sky-blue speed line in the hero, a saffron sparkle behind a number) but anything CLICKABLE is magenta or cyan.

## 3. Typography rules

- **Font stack:** Orbitron primary (geometric futurist display), Space Grotesk as fallback for warmth, Inter as universal fallback. Body is Inter — Orbitron at body sizes reads as costume. The display/body split is intentional: display goes full-genre, body stays readable.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 32 / 48 / 72 / 104.
- **Body:** 15px. Weight 400 default, 600 for emphasis. Body text stays Inter, not Orbitron.
- **Display:** weight 600–700 in Orbitron. Tracking lean WIDE at display sizes — `letter-spacing: 0.02em` at 48px, `0.04em` at 72px+. The widened tracking is part of the genre; tight tracking on Orbitron flattens its character.
- **UPPERCASE for short labels.** Eyebrows, status badges, navigation chips. `letter-spacing: 0.12em` on uppercase labels.
- **Mono for readouts.** Tabular data, timestamps, "BUILD 1.0.2"-style technical chips use JetBrains Mono. Mixing mono numerals into a body paragraph is fine — it's part of the HUD-leaning genre.
- **Line height:** 1.55 on body, 1.05 on display (display sizes lean tight to feel chunky).
- **No serifs anywhere.** Serif body in this system reads as a category error.

## 4. Spacing & density

- **Section padding:** 96px vertical on desktop, 64px on mobile. The system breathes more than terminal-grid (which is dense-utility) but less than the editorial systems.
- **Panel padding:** 24–28px inside neon-edged panels.
- **Radius:** 8px on cards and buttons (sharp-ish, arcade), 999px on pills only. Going to 16px+ drifts toward luminous-glass; staying at 0–4px drifts toward terminal-grid.
- **Gutters:** 16–20px between panels.

Density runs medium — not dense like a HUD, not loose like a magazine. The atmosphere is dramatic, so vertical scroll is generous.

## 5. Signature moves & avoid list

**The glow border is mandatory.** Panels and primary buttons carry both a saturated outline AND a soft outer glow in the same accent color:

```css
.panel {
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: 0 0 24px rgba(255, 43, 214, 0.35), 0 0 1px rgba(255, 43, 214, 0.8);
}
.btn-primary {
  background: var(--accent);
  color: var(--accent-fg);
  box-shadow: 0 0 20px rgba(255, 43, 214, 0.55);
}
```

Without the glow, panels read as "regular dark theme with a magenta border" — the genre needs the bloom. Cyan panels pair with cyan glow; never mix a magenta border with cyan glow (that's a different aesthetic — vaporwave-bloom — which is its own thing).

**Magenta → cyan gradients.** The two accents pair as gradient stops on hero typography or hero strips:

```css
.hero-title {
  background: linear-gradient(95deg, var(--accent) 0%, var(--accent-alt) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```

One gradient run per artifact. Two gradient headings on the same page reads as parody.

**The scanline overlay.** Faint horizontal scanlines (`background-image: repeating-linear-gradient(transparent, transparent 2px, rgba(255,255,255,0.03) 3px)`) on hero panels or full-page backgrounds. Subtle — the scanline carries the CRT feel without dominating the readable content.

**The one decisive flourish per artifact:** in this system, the flourish is usually *one gradient hero word* (per above), *one neon pulse animation* on a status LED, or *one full-bleed scanline-textured hero panel*. Pick one; layering all three reads as a 2010s rave flyer.

**Avoid:**

- Pure black background (drifts to terminal-grid).
- Soft, muted, or pastel accents (kills the neon).
- Hairline alpha borders (drifts to luminous-glass).
- Photography of corporate subjects (the genre is illustrated / 3D / pixel-art / glitch — or no photography at all).
- Marketing-corporate copy voice. "Enterprise-grade solutions" against this palette is comedy. Voice should match — energetic, declarative, short.
- A THIRD interactive accent. Magenta + cyan is the budget. Add a green button and the magic dies.
- Drop shadows in the standard SaaS sense (`0 4px 12px rgba(0,0,0,0.4)`). The system uses GLOW shadows; flat drop shadows read as a Material card imported by mistake.
- Light mode. This system is dark-only. Light-mode Neon Arcade is a different system (gradient-vivid serves that brief instead).
