# Gradient Vivid

> Category: marketing
> Bold multi-stop gradient hero, saturated brand washes, confident geometric type. The SaaS-marketing / launch-page / product-announcement zone.

## 1. Visual theme & atmosphere

This is the "one big idea, full chest" system. It belongs on surfaces whose entire job is to communicate a single product or launch — a SaaS landing page, a product-announcement microsite, a YC-batch demo page, a Series-A launch site. The hero IS the page: an oversized headline against a bold multi-stop gradient, one decisive CTA, a single product visual that takes the rest of the fold. Below the fold the system goes calmer — clean white sections with feature cards — but the hero commits hard. The system says *"we have something to show you, and we are showing it confidently."*

The difference from `modern-minimal` (B2B credibility) is energy. Modern-minimal is restrained; one cobalt accent appearing exactly twice on the page. Gradient Vivid is *confident-loud* — a purple-to-teal gradient occupying half the hero, accent buttons that glow, a product shot that breaks past the column. The difference from `neon-arcade` is mood. Neon Arcade is dark/cyberpunk/electric; Gradient Vivid is light/marketing/optimistic. Reach for this when the brief is "a product launch on a Tuesday at 9am Pacific."

Like `playful-pop` and `neon-arcade`, this is a two-accent system. The pairing IS the brand signal; the gradient between purple and teal is the visual ID. A third accent collapses the system.

## 2. Color palette & roles

- **Background** (`--bg`, `#fafbff`): cool near-white, faintly violet-leaning. Primes the eye for the saturated gradient washes; pure-white in this system reads as "we forgot to design the page."
- **Surface** (`--surface`, `#ffffff`): clean white card tier. Below-the-fold feature cards sit in pure white to give the hero its dominance.
- **Foreground** (`--fg`, `#0d0c25`): deep ink with a faint violet cast. Pairs with the cool background to set the chord.
- **Muted** (`--muted`, `#5e5d7a`): cool muted lavender-grey for metadata, captions, secondary copy.
- **Border** (`--border`, `#e6e6f2`): cool hairline. Mostly invisible — the system uses padding and gradient stops for separation, not lines.
- **Accent** (`--accent`, `#6b3df5`): saturated purple. Primary CTA fill, primary gradient stop, hero glow, focus ring.
- **Accent hover** (`--accent-hover`, `#5928e0`): darken-on-hover (the gradient/light system has enough drama; a brightening hover reads as too much).
- **Accent fg** (`--accent-fg`, `#ffffff`): white on purple.
- **Accent alt** (`--accent-alt`, `#3df5d4`): bright teal. The second gradient stop, the secondary CTA option, the "highlighted feature" badge color.
- **Accent alt fg** (`--accent-alt-fg`, `#0d0c25`): deep ink on bright teal.
- **Semantic** (`--good` `#2ec07a`, `--warn` `#ffae1f`, `--bad` `#f14060`): tuned to the brand chord. The "bad" red leans coral rather than CRT red so it fits next to the violet/teal.

The discipline: **purple + teal, used together**. The two accents appear together — as gradient stops, as primary/secondary CTA pair, as alternating-feature-card backgrounds. NEVER ship Gradient Vivid with only one accent active; the whole brand signal is the pairing.

## 3. Typography rules

- **Font stack:** Geist primary (modern geometric sans with strong display character), Space Grotesk fallback, Inter universal fallback. Display and body share the family; weight does the work.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 36 / 56 / 80 / 112.
- **Body:** 16px on marketing-body, 14px on dense UI. Weight 400 default, 600 for emphasis. Line height 1.55.
- **Display:** weight 600 (semibold) — heavy enough to compete with the gradient, light enough to stay legible at scale. Tight tracking on ≥56px: `letter-spacing: -0.025em`. Tighter at ≥80px: `-0.03em`.
- **Gradient text on the brand word.** The single most-important word in the hero headline gets the brand gradient applied via `background-clip: text` — purple to teal. One per page; gradient text on two phrases reads as 2017 tutorial.
- **text-wrap:** `balance` on h1, `pretty` on body.
- **No serifs.** Pairing a serif with a saturated gradient reads as a category clash — both elements are competing for "the thing carrying personality."

## 4. Spacing & density

- **Section padding:** 112px vertical on desktop, 72px on mobile. The hero in particular often pushes to 144px+ — it needs the breathing room to absorb the gradient.
- **Card padding:** 32–40px. Feature cards below the fold are generous.
- **Radius:** 14px on cards and buttons. 999px on pills. Goldilocks — not tight enough for dev-tool, not loose enough for consumer-friendly.
- **Gutters:** 24px between cards.

Density runs medium-loose on the marketing fold and medium on feature sections. Status-density / dashboard density is a wrong fit — this is a marketing system, not a product surface.

## 5. Signature moves & avoid list

**The hero gradient is mandatory.** The hero section's background is a multi-stop diagonal gradient between the two accents, often softened with a near-white stop in the middle so the type sits readably:

```css
.hero {
  background: linear-gradient(135deg,
    var(--accent) 0%,
    color-mix(in oklab, var(--accent) 35%, var(--bg)) 35%,
    var(--bg) 55%,
    color-mix(in oklab, var(--accent-alt) 30%, var(--bg)) 80%,
    var(--accent-alt) 100%);
}
```

Or a radial-glow variant — two soft saturated blobs (one purple, one teal) on opposite corners, fading to `--bg`:

```css
.hero {
  background:
    radial-gradient(circle at 10% 10%, var(--accent) 0%, transparent 35%),
    radial-gradient(circle at 90% 90%, var(--accent-alt) 0%, transparent 35%),
    var(--bg);
}
```

Without the gradient hero, this system is just "purple + teal SaaS marketing" — pleasant, but not Gradient Vivid.

**The gradient text headline.** Apply the brand gradient (purple → teal) via `background-clip: text` to ONE word in the headline — the brand word, the key noun. Implementation:

```css
.gradient-word {
  background: linear-gradient(95deg, var(--accent) 0%, var(--accent-alt) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```

ONE gradient run per page. Two gradient phrases reads as a 2017 dribbble shot.

**The product-shot break.** A product image (or large geometric mark) that breaks past the column / overflows the section bottom by 80–120px. This is the marketing-page move that signals confidence — the product is so present it doesn't fit in its own column.

**The one decisive flourish per artifact:** gradient hero + gradient text + product break. Pick one of those three to push harder than the others; layering all three at max settings reads as overwhelming.

**Avoid:**

- Pure white background. The cool `--bg` IS part of the chord.
- A SaaS-default "one-color accent" approach. Gradient Vivid lives on the purple/teal pairing; using only purple drops you back into modern-minimal territory.
- Three or more interactive accents. Stay on the two.
- Hero photographs of generic-corporate subjects. Use product shots, abstract 3D / geometric illustration, screen captures of the actual product. The gradient is the personality; photography of people competes with it.
- Serif type. Gradient Vivid + serif reads as "we couldn't decide what we are."
- Drop shadows on the gradient hero. The gradient IS the depth.
- Below-the-fold sections that try to keep the gradient energy. The fold-line is a *deliberate* shift — calm white sections below let the hero land. Cards in the gradient color below feel like undisciplined.
- Marketing-corporate copy voice ("Best-in-class enterprise solutions"). Pair with declarative, confident, short voice — "Ship faster. With less.", "The agent OS for your laptop.", "Built for the people who build."
- Light gradients (low saturation purple ⟶ pale teal). The saturation IS the genre; pastel-ifying the gradient kills it.
