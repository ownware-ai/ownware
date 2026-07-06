# Neutral Modern

> Category: starter
> A clean, opinion-light default. Use when the brief doesn't call for a specific mood.

## 1. Visual theme & atmosphere

Calm, functional, quietly confident. No ornament. Content-first, chrome-second. This is the design system the agent reaches for when the user hasn't named a direction, the brief is utility-driven, or the artifact is meant to communicate without competing for attention — B2B SaaS, internal admin, dashboards, status pages, documentation, the kinds of surfaces where "no-look-and-feel" is the look.

The signature move is restraint: a single accent color, generous-but-not-luxurious whitespace, system-stack typography, and unfussy components that work first time on first paint. There is one decisive flourish per artifact — a focused hero metric, a clean chart, a single illustrated empty state — and the rest of the surface gets out of its way.

## 2. Color palette & roles

- **Background** (`--bg`, `#fafafa`): the page canvas. Off-white, not pure white, so primary surfaces have somewhere to step up to.
- **Surface** (`--surface`, `#ffffff`): cards, modals, sticky chrome, anything that should read as "this is content."
- **Foreground** (`--fg`, `#111111`): primary text. Near-black, not pure black, easier on the eye on long reads.
- **Muted** (`--muted`, `#6b6b6b`): secondary text, captions, helper copy. Still WCAG AA on `--surface`.
- **Border** (`--border`, `#e5e5e5`): dividers, card borders, input outlines.
- **Accent** (`--accent`, `#2f6feb`): single cobalt accent for primary CTAs, links, focus rings, one hero element per artifact.
- **Accent hover** (`--accent-hover`, `#1f5fd6`): darken-on-hover for filled buttons.
- **Accent fg** (`--accent-fg`, `#ffffff`): text/icons on top of `--accent` fills.
- **Semantic** (`--good` `#17a34a`, `--warn` `#eab308`, `--bad` `#dc2626`): used sparingly, paired with an icon so color isn't carrying meaning alone.

## 3. Typography rules

- **Font stack:** `'Inter', -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif` for both display and body. Inter where installed, system fallback everywhere else. Monospace via `ui-monospace, 'JetBrains Mono', Menlo`.
- **Scale (px):** 12 / 14 / 16 / 20 / 24 / 32 / 48 / 64. Eight steps, no more. Body at 14 in dense layouts, 16 in marketing.
- **Line height:** 1.5 on body, 1.2 on headings.
- **Letter-spacing:** -0.01em on display sizes ≥ 32px. No tracking on body.
- **text-wrap:** `pretty` on all `<p>`, `balance` on h1 / h2.

## 4. Spacing & density

- **Section padding:** desktop 80px vertical / mobile 48px vertical. Side margins: container max-width 1200px, side gutters auto.
- **Component padding:** cards 20px, buttons 10×16, inputs 10×12.
- **Card radius:** 12px. Pills 999px. Inputs 8px.
- **Gutters between cards in a grid:** 16–20px depending on density.

Default density is medium. The user can dial up (denser admin) or down (more spacious marketing) via the `tweaks` skill without changing the system identity.

## 5. Signature moves & avoid list

**The one decisive flourish per artifact:** in this system, the flourish is almost always a *single* well-tuned element — one hero number rendered large, one chart with subtle gradient under the line, one empty-state illustration carefully placed. Restraint over ornament; the flourish earns its place by being the only one.

**Avoid:**

- Multiple accent colors. One cobalt CTA and one cobalt link is fine; a second accent for "secondary actions" muddies the hierarchy.
- Heavy shadows. `box-shadow: 0 1px 2px rgba(0,0,0,0.04)` on a focused card is the ceiling. Nothing reads as elevated by default.
- Warm beige / cream / peach background. The Neutral Modern system is cool-leaning and slightly off-white; pulling toward warm tones makes it read as "the AI default canvas" and breaks the brand.
- Display fonts at body sizes. Inter is fine at 14 / 16 / 20 — that's display *and* body in this system.
- Gradient backgrounds on hero sections unless brand calls for them. A single subtle radial gradient behind a hero number is the maximum.
