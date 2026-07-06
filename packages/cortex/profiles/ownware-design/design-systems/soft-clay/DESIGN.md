# Soft Clay

> Category: friendly
> Pastel claymorphic surfaces with chunky soft-relief shadows. The friendly-tool / learning-app / consumer-marketing zone.

## 1. Visual theme & atmosphere

This is the "tactile and approachable" system. It belongs on surfaces aimed at warm consumer audiences — a learning app for kids, a habit tracker, a meditation product, a marketing landing page for a creator tool. Elements look molded from soft clay: heavy rounded corners, gentle outer + inner shadows, a warm-cream floor that feels like paper rather than screen. Nothing is sharp; nothing is glossy. The system says *"I'm friendly. You can touch me. Nothing here will hurt."*

The difference from `warm-soft` (warm minimal) is depth and weight. Warm-soft is flat — same family, flatter execution. Soft Clay is *dimensional* — every card sits proud of the floor as if pressed out of clay, and that softly-extruded quality is the whole brand. Reach for this when the artifact's job is to feel welcoming and unintimidating, especially for users who don't think of themselves as "technical."

The genre depends on the **soft-relief shadow pair** described in §5. Without it, the system collapses to a regular pastel theme. The shadow isn't optional decoration — it IS the system.

## 2. Color palette & roles

- **Background** (`--bg`, `#f7eee6`): warm-cream floor. Reads as paper or unbleached linen, not as screen-white.
- **Surface** (`--surface`, `#fff8f1`): card and panel fill. Slightly *warmer* than `--bg`, not lighter — the warmth difference is what makes cards feel molded rather than cut out.
- **Foreground** (`--fg`, `#2b211c`): warm dark, not pure black. Pure black on warm cream reads as a clash; this is sepia-leaning charcoal.
- **Muted** (`--muted`, `#8a7a70`): secondary text, captions. Warm grey-brown. Tuned to roughly AA on `--surface`.
- **Border** (`--border`, `#ead8c7`): warm, low-contrast hairline. Used mainly for input outlines and table dividers — most card edges have no border; depth comes from shadow.
- **Accent** (`--accent`, `#e07a5f`): one warm coral. Primary CTA fill, the link underline, the focus ring, one decisive hero element. The whole system's saturation budget lives here.
- **Accent hover** (`--accent-hover`, `#d0664a`): darken-on-hover for filled CTAs.
- **Accent fg** (`--accent-fg`, `#ffffff`): white on the coral fill.
- **Semantic** (`--good` `#6a9968`, `--warn` `#d99a3a`, `--bad` `#c44a4a`): all three desaturated half a step to live on the warm surface. CRT-bright semantic colors (#22c55e green, #ef4444 red) read as foreign objects in this system — they shout, and Soft Clay never shouts.

The discipline: **pastels live on the surface, saturation lives only on the accent**. If the brief asks for "more color," widen the surface palette warmer (sage, dusty blue, warm pink as additional card tints) — do NOT add a second saturated accent. Two saturated accents drift the system from "friendly" toward "playful-pop"; if that's the right answer, use `playful-pop` instead.

## 3. Typography rules

- **Font stack:** Nunito where installed (its rounded geometric character matches the soft-corner system), Inter as fallback. Both display and body use the same family; weight does the work.
- **Scale (px):** 12 / 14 / 16 / 18 / 22 / 28 / 36 / 48 / 64.
- **Body:** 16px on marketing, 14px on dense UI. Weight 500 default (Nunito reads thin at 400), 700 for emphasis. The slightly-heavier default gives the body a tactile feel that matches the surfaces.
- **Display:** weight 800 (extrabold). Tight tracking on ≥28px: `letter-spacing: -0.015em`.
- **Line height:** 1.55 on body (a touch looser than a SaaS default — friendlier), 1.2 on headings.
- **text-wrap:** `pretty` on `<p>`, `balance` on h1 / h2 / h3.
- **Avoid hairline display weights.** Weight 300 at any size reads as anaemic in this system; the visual language is plush, and plush needs heft.

## 4. Spacing & density

- **Section padding:** 88px vertical on desktop, 56px on mobile.
- **Card padding:** 24–32px. Cards in this system are roomy; squeezing content tight kills the molded feel.
- **Radius:** 22px on cards and buttons. 999px on pills. NEVER 4–8px — small radii in a warm-cream system read as "uncertain SaaS" rather than "deliberate friendly."
- **Gutters:** 20–24px between cards.

Density runs medium-loose. If the artifact's brief is "show 80 rows of data with tight density", you've picked the wrong system; use `tech-utility` or `modern-minimal`.

## 5. Signature moves & avoid list

**The soft-relief shadow pair is mandatory.** Every card and elevated button uses a *paired* shadow — one warm outer drop, one bright inner highlight — to read as molded clay rather than as a flat card with a drop shadow. The canonical pattern:

```css
.card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow:
    8px 10px 24px rgba(128, 92, 70, 0.18),   /* warm outer drop */
    -8px -8px 20px rgba(255, 255, 255, 0.75); /* bright inner lift */
}
```

The first stop pushes the card "down and right" into the floor; the second stop lights its "up and left" edge. Without BOTH, the card reads as a regular drop-shadow card. The genre dies on a single shadow.

**The one decisive flourish per artifact:** in this system, the flourish is usually *one oversized hand-illustrated decoration* (a doodled arrow, a sketched circle, a hand-drawn underline in coral) on the hero, *one tilted card* at a few degrees rotation as a deliberate counterpoint to the otherwise-orthogonal grid, or *a single chunky pill button* sized 1.5× the body's button height with the soft-relief shadow exaggerated. Pick one.

**Avoid:**

- Pure-white surface (`#ffffff`). On a warm-cream `--bg`, a pure-white card reads as a cut-out, not a molded element. Use `--surface` (`#fff8f1`).
- A single drop shadow without the inner highlight. That's a regular card, not clay.
- Hard-cornered cards (radius < 12px). The genre's identity depends on heavy rounding.
- Hard `#000` borders. The depth is in the shadow, not the outline.
- A second saturated accent. If the brief needs more color, tint the surfaces (sage card, dusty-blue card, warm-pink card), don't add a second accent.
- Cool/blue text. `--fg` is warm dark; cool-grey body text reads as a clash. Stick with the warm muted ramp.
- Gloss or gradients on the surface. Soft Clay reads as matte clay; gradients on the panel itself drift toward Glassmorphism, which is a different system.
- Sharp icon stroke weights. Icons in this system match the surfaces — 1.5–2px rounded strokes, rounded line caps.
