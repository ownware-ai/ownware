# Brutalist Experimental

> Category: experimental
> Loud, opinionated, statement-making. Heavy display, hot accent, deliberate asymmetry.

## 1. Visual theme & atmosphere

The "agency is making a statement" system. This is the design vocabulary of creative agencies, fashion drops, music labels, art shows, festival sites, design portfolios, anywhere the surface itself is a piece of communication. Where modern-minimal apologises for its presence and editorial-monocle whispers, brutalist-experimental *announces*. The page should be memorable a week later.

The system is not actually 1970s concrete-bunker brutalism. It's *web brutalism* — the post-2018 design movement that pushed back against the rounded-soft-shadow Material era. Hard borders. Black-on-cream or black-on-cream-with-one-hot-color. Asymmetric layouts. Display type sized at 80–160px on desktop. Deliberate refusal of the "comfortable" UI patterns that defined the prior decade.

It's a high-risk system. Done well it reads as confident and contemporary. Done badly it reads as "agency tried too hard." The discipline is in the *deliberateness* — every loud move has to be load-bearing, not decorative. One oversized display headline, fine. Five oversized blocks competing for attention, slop.

This system is the right answer when:

- The brand *wants* to look different from every other site. The brief mentions "make it bold", "stand out", "creative", "unconventional."
- The audience is design-literate or aesthetics-led. Creatives, art buyers, fashion, music.
- The page is a *statement*, not a conversion funnel. Portfolios, manifestos, festival lineups, art exhibitions.

It's the **wrong** answer for any surface where the user needs to perform a task quickly. A bank using brutalist-experimental for online banking is a hostile environment.

## 2. Color palette & roles

- **Background** (`--bg`, `#f4f0e6`): pale cream-newsprint. Off-white with a hint of warmth — reads as raw paper or unbleached canvas. Sometimes inverted to `#0a0a0a` for a "dark brutalist" cut.
- **Surface** (`--surface`, `#f4f0e6`): same as `--bg`. Brutalist systems often have no separate card surface — content sits directly on the canvas with hard borders defining regions.
- **Foreground** (`--fg`, `#0a0a0a`): near-pure black. The system loves hard contrast.
- **Muted** (`--muted`, `#4a4a4a`): used sparingly. Brutalist systems usually do not have a "tertiary" voice — text is either loud or absent.
- **Border** (`--border`, `#0a0a0a`): hard black borders, often 2–4px. The border is a load-bearing component, not a hairline.
- **Accent** (`--accent`, `#ff4d00`): hot orange. One sledgehammer color. Used on one or two elements per page, deliberately.
- **Accent fg** (`--accent-fg`, `#0a0a0a`): black on the accent — pure black, deliberately ungentle.
- **Semantic** (`--good` `#006b3c`, `--bad` `#c41e3a`): saturated. Brutalist semantic colors don't blend; they shout.

## 3. Typography rules

- **Display:** serif. `"Times New Roman", Georgia, "Iowan Old Style", serif`. Sized **enormously** — 80–160px on desktop hero, 56–80px on section openers. The display face is the identity.
- **Body:** sans. `-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif`. At 15–17px, often left-aligned with no centered comfort.
- **Mono:** `ui-monospace, monospace`. Used for metadata, captions, dates, labels — anything that wants to read as "system text" against the loud display.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 32 / 56 / 80 / 120 / 160. Note the big gaps — brutalist systems jump scale rather than step gently.
- **Line height:** 1.5 on body, 0.95–1.0 on display (display compresses tightly).
- **Letter-spacing:** -0.04em on display ≥80px (the type *crushes* together). 0 on body.
- **text-wrap:** `pretty` on body, `balance` on h1 / h2 — though brutalist systems sometimes deliberately leave awkward line breaks as a stylistic choice.

## 4. Spacing & density

- **Section padding:** asymmetric. 80–160px on one side, 8–24px on the other. Brutalist layouts deliberately refuse centered, gutter-balanced compositions.
- **Component padding:** buttons 12×24, inputs 12×16. No card padding — content sits directly between borders.
- **Radius:** **0px.** Default to hard corners. The exception: one radical 32–48px radius on *one* element per page, deliberately, as a counterpoint to the otherwise-square layout.
- **Borders:** 2–4px solid `--border`. Often heavier than expected. The border is structural, not decorative.
- **Gutters:** wildly variable. The system rejects the modern web's "everything aligns to an 8px grid" — instead, large negative space and tight clusters alternate.

## 5. Signature moves & avoid list

**The one decisive flourish per artifact:** in this system, the flourish is *one move that violates the rest of the system on purpose*. A single 200-degree rotated element. A single oversized circle in `--accent` overlapping a text block. A single line of display type set in a wildly unexpected weight or treatment (strikethrough, outlined, scribbled-over). One move, executed with absolute conviction.

**Avoid:**

- Rounded soft-shadowed cards. Anywhere. Even one immediately reads as "this brand can't decide if it wants to be brutalist or not."
- Gradients. The system is flat-color by definition. A gradient slips you out of the genre.
- Pastel accents. The accent is hot — orange, electric blue, hot pink, neon green. Pastels are anti-brutalist.
- Multiple display fonts. One serif. Done.
- Sans-serif display (Inter, Helvetica) sized at 120px+. That reads as "tech startup", not "brutalist agency." If the brief specifically demands sans display, switch to a different system (`modern-minimal` for big sans display).
- Tasteful drop shadows. The system has zero shadows. None.
- Symmetry. A page where everything centers and gutters match is the opposite of this system.
- Apologising for the loudness. If the artifact is brutalist, commit. Halfway brutalist is the worst version.
