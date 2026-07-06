# Modern Minimal

> Category: minimal
> Clean, single-accent, B2B credibility. The Linear / Stripe / Vercel zone.

## 1. Visual theme & atmosphere

This is the "we take ourselves seriously, but we're not cold" system. It's the dominant aesthetic of modern B2B SaaS — Linear, Stripe, Vercel, Notion's marketing site, Anthropic, Cursor, Supabase. The signal is *credibility through restraint*: one accent color, generous-but-disciplined whitespace, geometric type at a clear scale, components that look like they were built by an engineer with taste rather than a brand designer with maximalist instincts.

The difference from `neutral-modern` (the starter) is intent. Neutral-modern is what you build when you don't know what to build. Modern-minimal is what you build when you've *chosen* this aesthetic deliberately — it's the right answer for a developer-tools landing page, a fintech pricing page, an analytics dashboard for the kind of operator who self-identifies as a power user.

Density runs slightly tighter than neutral-modern. Type is more confident — body at 15–16px, headings step harder. The accent does more work: it appears on the focus ring, the link underline, the primary CTA fill, and one decisive hero element. Everywhere else, the system is monochrome.

## 2. Color palette & roles

- **Background** (`--bg`, `#fafafa`): page canvas. Off-white, cool-leaning.
- **Surface** (`--surface`, `#ffffff`): cards, modals, nav chrome. Pure white earns the contrast against `--bg`.
- **Foreground** (`--fg`, `#111111`): primary text and dense UI fills. Near-black.
- **Muted** (`--muted`, `#6b6b6b`): secondary text. Tuned to AA on `--surface`.
- **Border** (`--border`, `#e5e5e5`): hairline dividers, card outlines, input outlines.
- **Accent** (`--accent`, `#2f6feb`): one cobalt accent. Primary CTA fill, link color, focus ring, brand mark, one hero treatment per artifact.
- **Accent hover** (`--accent-hover`, `#1f5fd6`): darken-on-hover for filled CTAs.
- **Accent fg** (`--accent-fg`, `#ffffff`): text/icons on filled accent surfaces.
- **Semantic** (`--good` `#17a34a`, `--warn` `#eab308`, `--bad` `#dc2626`): used sparingly. Always paired with an icon for state.

The discipline: **one color does the work**. A second "secondary accent" muddies the hierarchy and reads as indecisive. If the brief genuinely demands two semantic colors (e.g. primary action + destructive action), one of them is `--bad`, not a second blue.

## 3. Typography rules

- **Font stack:** `'Inter', -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif`. Inter where installed, system fallback elsewhere. Both display and body use the same family — the variation comes from weight and size, not face-switching.
- **Scale (px):** 12 / 14 / 15 / 16 / 18 / 20 / 24 / 32 / 40 / 56 / 72.
- **Body:** 15–16px on marketing, 14px on dense UI. Weight 400 default, 500 for emphasis. Never 300; thin weights read as anaemic at body sizes.
- **Display:** weight 600 (semibold). Tight tracking on ≥32px: `letter-spacing: -0.01em`. Tighter on ≥56px: `-0.02em`.
- **Line height:** 1.5 on body, 1.2 on headings, 1.1 on display ≥56px.
- **text-wrap:** `pretty` on `<p>`, `balance` on h1 / h2 / h3.
- **Mono:** for code, table numerals, anything tabular.

## 4. Spacing & density

- **Section padding:** 96px vertical on desktop, 64px on mobile. The system breathes; cramped sections break the credibility signal.
- **Component padding:** cards 18–24px, buttons 10×16, inputs 10×14, table cells 12×16.
- **Radius:** 8px on cards, buttons, inputs. 999px on pills. 6px on small chips. Nothing more rounded — Modern Minimal stops at "soft", doesn't go to "playful."
- **Gutters:** 16–24px between cards in a grid. 8px between in-row chips.

Density runs medium-tight on UI, medium-loose on marketing. The same artifact rarely needs both; pick one and commit per surface.

## 5. Signature moves & avoid list

**The one decisive flourish per artifact:** in this system, the flourish is usually *the chart* (a hand-tuned SVG line with a subtle gradient fill under it), *the focus state* (an unusually crisp `:focus-visible` outline that says "we care"), or *one oversized element* — a single hero number, a single quote, a single screen capture — sized 2–3 steps above the surrounding type scale.

**Avoid:**

- Multiple gradient backgrounds. One subtle gradient on a hero — fine. Two — slop. Three — abandon the artifact.
- Warm color tones bleeding into the neutrals. The system is cool-leaning; warming `--bg` toward beige drifts you toward `warm-soft` and breaks the credibility signal.
- Heavy shadows. `box-shadow: 0 1px 2px rgba(0,0,0,0.05)` is the ceiling. Anything deeper reads as Material Design, which is the wrong era.
- Two accent colors. One. Always.
- Aggressive border radius. 16px+ rounded cards read as consumer; this system stops at 12px.
- Display fonts other than Inter. The whole system hinges on one face working for everything; reaching for Manrope, Plus Jakarta Sans, or Geist is a brand pivot, not a refinement.
