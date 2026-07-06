# Warm Soft

> Category: consumer
> Approachable, friendly, consumer-comfort. Cream surface, warm terracotta accent, generous radii.

## 1. Visual theme & atmosphere

This is the "make a person feel okay" system. It's the design vocabulary of consumer products that need to disarm — health apps explaining a diagnosis, education tools onboarding a learner, finance products talking to humans (not professional traders), wellness, parenting, anything where the user arrives with anxiety and needs the surface to read as *safe*.

The visual register sits between editorial-warmth and modern-minimal. Cream background instead of off-white. Body type sized up by one or two steps to feel more spoken than dense. Radii generous — cards round at 14–16px, buttons at 12px, never pills unless the brief asks. A warm terracotta accent (`#c96442`) replaces cobalt — it reads as approachable rather than authoritative.

The trap with this system is overcorrecting into "AI default beige." Most agents asked to make something "warm" reach for the same warm-beige canvas with the same orange-brown rounded cards and the same Fraunces display heading, and the result is the slop pattern every reader has now seen a thousand times. The discipline here is to keep the warmth *specific* — `#fdf9f3` is cream, not beige; the terracotta is `#c96442` (a fired-clay color), not pumpkin; the display serif is optional, not mandatory.

## 2. Color palette & roles

- **Background** (`--bg`, `#fdf9f3`): warm cream. Reads as paper or natural canvas, never as orange or peach.
- **Surface** (`--surface`, `#ffffff`): cards, form fields, primary content surfaces. Pure white pops cleanly against cream.
- **Foreground** (`--fg`, `#2a1f17`): primary text. Deep warm brown, not black — warm tones throughout keep the system cohesive.
- **Muted** (`--muted`, `#7a6a5d`): secondary text. Tuned warm to match `--fg`'s family. Still AA on `--surface`.
- **Border** (`--border`, `#ebe3d8`): hairline rules and card outlines. Warm, never grey.
- **Accent** (`--accent`, `#c96442`): terracotta. Primary CTA fill, links, focus ring, brand mark. One accent, used confidently.
- **Accent hover** (`--accent-hover`, `#b15533`): darken on hover.
- **Accent fg** (`--accent-fg`, `#ffffff`): white on filled buttons.
- **Semantic** (`--good` `#2f7d4a`, `--bad` `#b53a2a`): warm-adjusted greens and reds that don't clash with terracotta.

## 3. Typography rules

- **Display:** optional serif (`'Fraunces', "Iowan Old Style", Georgia, serif`) or all-sans (`Inter`). Pick one; consumer-warm brands often work better all-sans because serif tilts more editorial. **Default to Inter for display unless the brief asks for a serif.**
- **Body:** sans. `'Inter', -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif`.
- **Mono:** `ui-monospace, 'JetBrains Mono', Menlo, monospace`. Sparingly.
- **Scale (px):** 14 / 15 / 16 / 18 / 20 / 24 / 32 / 48 / 64. Body steps up one notch (16 / 18 on marketing) — reads more spoken.
- **Body line-height:** 1.55. Slightly more open than modern-minimal's 1.5 — gives the page room to breathe.
- **Headings line-height:** 1.2. Letter-spacing -0.01em on ≥32px.
- **text-wrap:** `pretty` on body, `balance` on h1 / h2.
- **Weight:** body weight 400, emphasis 500, never 300.

## 4. Spacing & density

- **Section padding:** 80–96px vertical desktop, 56px mobile. Medium-loose.
- **Component padding:** cards 20–28px, buttons 12×20, inputs 12×16.
- **Radius:** 14px on cards, 12px on buttons, 8px on inputs. Generous but not extreme.
- **Pills:** 999px, used for tags and small action chips.
- **Gutters:** 20–28px between cards in a grid. The page should feel handed to the user, not stacked at them.

## 5. Signature moves & avoid list

**The one decisive flourish per artifact:** in this system, the flourish is *warmth that earns its place* — a single inline SVG illustration (hand-drawn, gently irregular), a single soft-shadowed card slightly lifted off the cream background, a single warm gradient (e.g. `radial-gradient(at top, color-mix(in oklch, var(--accent) 8%, transparent), transparent)`) behind a hero number. One warm gesture, then back to the clean surface.

**Avoid:**

- Generic beige / peach / pumpkin / pink canvases. Cream-specific (`#fdf9f3` ± small variation) is the brand mark. Drifting to `#fdf3e7` (peach) or `#f5e8d6` (tan) drifts you into AI-default-warm slop.
- Multiple warm accents. One terracotta. A pumpkin secondary and a sage tertiary multiplies into kitsch.
- Heavy gradient hero backgrounds. The cream is the warmth; the gradient is supplementary, not load-bearing.
- "Hand-drawn" SVG illustrations that look like every Notion clone's hero image. If you use illustration, use it once and use it well.
- Massive border radius (24px+). Generous, not playground. 14–16px tops on cards.
- Pure-black text. The warm brown `#2a1f17` is identity-defining; black breaks the warmth.
- All-serif everywhere. One serif moment in the artifact is enough; serif body type drifts editorial.
