---
name: brief-parser
description: 'Convert a fuzzy natural-language brief into a locked spec the artifact skill can build from. Resolves seven required dimensions (kind, audience, direction, sections, density, fidelity, voice) and flags ambiguity instead of guessing. Use when the user lands with a paragraph instead of a clean checklist. Do NOT use after discovery has already produced a 4-6 line plan — that is already locked.'
trigger: /brief-parser
---

# Brief Parser — turn a paragraph into a buildable spec

## Overview

A real brief from a real user looks like: "I want a landing page for my dev tool. Should feel premium but not corporate. Inter font, dark mode probably. Maybe two CTAs at the top, three feature blocks, then pricing." Seventeen decisions are implied; only six are stated.

This skill is the parsing pass before `discovery` even gets to its five questions. It reads the brief, names every dimension that resolves cleanly, names every dimension that doesn't, and produces either a locked spec or a focused clarifying list. Discovery handles the "pick a direction" conversation; brief-parser handles the "what did the user actually say" upstream of that.

Use this when the user opens with a paragraph. Do not use this for one-line tweaks ("change accent to blue") — that's a surgical edit, not a brief.

---

## The seven dimensions — every brief resolves these

Every artifact this profile builds requires answers to seven dimensions. Anything else is a default the agent picks and documents.

| # | Dimension | What it answers | Where it comes from |
|---|-----------|-----------------|---------------------|
| 1 | `kind` | landing / dashboard / deck / mock / brand-sheet / magazine / prototype / critique | Always explicit. If you can't extract it, ask. |
| 2 | `audience` | One line describing the reader | Often implicit. Lift from product type if absent. |
| 3 | `direction` | Catalog id, named brand, reference URL, or one of the five fallback directions | Often vague ("clean", "premium"). Map per Section 2. |
| 4 | `sections` | The ordered list of regions | Often partial. Backfill from `kind` template. |
| 5 | `density` | spacious / balanced / dense | Usually implicit. Pick from mood + audience. |
| 6 | `fidelity` | sketch / draft / production-ready | Usually implicit. Default `production-ready` for solo founders. |
| 7 | `voice` | The copy register: editorial / direct / playful / technical | Lift from product + audience. |

If you cannot resolve a dimension from the brief AND cannot pick a defensible default, that dimension goes in the "ask" list.

---

## Critical Constraints

1. **Read every sentence of the brief twice before mapping.** First pass: extract nouns. Second pass: extract feelings and constraints. Vague adjectives ("clean", "modern", "premium") are signals, not specs — log them as candidate moods, not as resolved palettes.
2. **Map natural language to closed vocabulary.** Use the mapping table in Section 2. If the user says a phrase that has no entry, do NOT invent a token — add it to the ambiguity list.
3. **Backfill `sections` from the kind template.** Section 3 gives the default region list per artifact kind. If the user named three sections, splice them onto the default and ask whether the rest are wanted.
4. **Never invent direction.** "Premium" is not a direction; `editorial-monocle` is. If the user said "premium and minimal", map to two candidate directions and surface both — don't pick silently.
5. **At most three clarifying questions.** If you have more, you misread the brief — re-read it. Seven open dimensions is real; seven actual questions is a wizard.
6. **Output a spec block, then stop.** Either a "Locked spec" the user nods at, or a "Spec + clarifying questions" block. Do not start building.

---

## 1. The parse — two passes

### Pass 1 — nouns and concrete values

Extract every concrete word: artifact type ("landing page"), product type ("dev tool", "SaaS"), color names ("dark mode", "navy"), font names ("Inter"), section names ("hero", "pricing"), numbers ("three tiers", "$19/$49/$99"), references ("like Linear", "kind of Vercel").

### Pass 2 — moods, audiences, constraints

Underline every adjective and constraint: "premium", "not corporate", "for solo founders", "no animations", "should breathe", "dense data table".

This second pass is where direction gets inferred — never from the first pass alone. "Dev tool" is not a direction; "dev tool for solo founders, premium feeling, not corporate" is.

---

## 2. Natural-language → closed-vocabulary mapping

Use this table to convert pass-2 adjectives into token candidates. Multiple matches per phrase is normal — surface all, do not collapse.

| Phrase the user said | Maps to direction candidates | Maps to density |
|----------------------|------------------------------|-----------------|
| "clean", "minimal", "simple" | `modern-minimal`, `editorial-monocle` | balanced |
| "premium", "high-end", "considered" | `editorial-monocle` | spacious |
| "warm", "friendly", "approachable" | `warm-soft` | balanced |
| "technical", "for developers", "dense" | `tech-utility` | dense |
| "bold", "loud", "statement" | `brutalist-experimental` | balanced |
| "dark mode", "dark theme" | `tech-utility` (default) or override on any direction | unchanged |
| "B2B", "for procurement", "enterprise" | `modern-minimal`, `editorial-monocle` | balanced |
| "consumer", "everyday user" | `warm-soft` | balanced |
| "data-heavy", "dashboard", "table" | `tech-utility` | dense |
| "editorial", "magazine-like" | `editorial-monocle` | spacious |
| Reference URL pasted | direction = "describe-and-confirm from URL" | infer from URL density |
| Named brand ("Linear", "Stripe") | catalog lookup via `list_design_systems({search: brand})` | infer |

When the table gives two candidates, the brief-parser output names both and lets discovery choose. When the table has nothing, the dimension goes to clarifying questions.

---

## 3. Section templates by kind

If `sections` is partial, splice the user's named sections onto the default for that kind. Order matters.

- **landing** → `hero` → `problem` → `solution` → `features` → `proof` (logos/testimonials) → `pricing-cta` → `footer`
- **dashboard** → `topbar` → `kpi-row` → `primary-panel` → `secondary-panels` → `table` → `footer-status`
- **deck** → `cover` → `problem` → `insight` → `solution` → `traction` → `team` → `ask` (per slide; deck skill defines the canonical 8-slide investor template)
- **mock** (mobile/desktop screen) → `chrome` → `header` → `primary-content` → `secondary-content` → `footer-nav`
- **brand-sheet** → `wordmark` → `palette` → `type-stack` → `voice` → `dos-and-donts` → `applications`
- **magazine** → `masthead` → `lede` → `feature-1` → `pullquote` → `feature-2` → `colophon`

If the user listed three sections in a kind that templates six, ask: "You named hero / features / pricing. Want me to also include problem framing, social proof, and a footer — or keep it tight to the three?"

---

## 4. The output shape — two cases

### Case A: clean parse — output a locked spec

Use this when all seven dimensions resolved.

```
## Spec (locked)
- Kind:       landing
- Audience:   solo founders evaluating a dev tool, $19-$99 budget tier
- Direction:  modern-minimal with `--accent: #5e6ad2` (Linear purple), --font-display: "Inter Display"
- Sections:   hero, problem, three-feature row, proof (3 logos + 2 quotes), pricing CTA, footer
- Density:    balanced (section padding 80px, card padding 20px)
- Fidelity:   production-ready
- Voice:      direct, second-person, no jargon. Headline imperative.

Nod and I hand off to artifact.
```

### Case B: ambiguous parse — output spec + clarifying questions

Use this when one or more dimensions can't resolve.

```
## Spec (partial)
- Kind:       landing                                    (extracted)
- Audience:   ??? — "developer tool" doesn't pin the buyer
- Direction:  candidates: modern-minimal, editorial-monocle   (you said "premium but not corporate")
- Sections:   hero, three features, pricing                  (you named these; standard template adds problem, proof, footer)
- Density:    balanced                                       (default for B2B)
- Fidelity:   production-ready                               (default)
- Voice:      direct, technical                              (extracted from "dev tool")

## Three questions
1. Audience — is the buyer the developer using it, or the lead at the team buying it? (Affects whether copy talks features or outcomes.)
2. Direction — `modern-minimal` (Linear/Vercel zone) or `editorial-monocle` (more serif, more whitespace, premium SaaS)?
3. Sections — keep tight to hero/features/pricing, or also include problem framing + proof? (Pricing pages without proof convert worse.)
```

---

## Concrete examples

### Example 1 — clean brief

**Brief from user:** "Editorial pricing page for an indie SaaS. $19, $49, $99 tiers. Target is solo founders. Should feel like a thoughtful object — Stripe meets Cereal magazine. Inter for body, serif for display. No animations."

**Pass 1 (nouns):** kind=pricing-page (special case of landing); product=indie SaaS; tiers=[$19, $49, $99]; audience=solo founders; type-body=Inter; type-display=serif; constraint=no-animations.

**Pass 2 (moods):** "editorial", "thoughtful object", "Stripe meets Cereal" — direction is unambiguously `editorial-monocle` with restrained-tech overrides.

**Output:**

```
## Spec (locked)
- Kind:       landing (pricing-focused)
- Audience:   solo SaaS founders, ~$50/mo budget, design-literate
- Direction:  editorial-monocle, Stripe-influenced
              overrides: --accent: #635bff (Stripe purple), --font-display: "Iowan Old Style", Georgia, serif
- Sections:   hero (single sentence + tier link), three-tier pricing, FAQ (5 q's), footer
- Density:    spacious (section padding 120px desktop / 64px mobile, card padding 32px)
- Fidelity:   production-ready
- Voice:      editorial, second-person, calm. Headline is a thesis sentence not a benefit shout.
- Constraints: no animations (no transitions on hover beyond color, no scroll triggers)

Nod and I hand off to artifact.
```

### Example 2 — ambiguous brief

**Brief from user:** "I need something modern and clean for my AI tool. Maybe like Apple? Some sections and pricing. Should look professional."

**Pass 1 (nouns):** kind=landing (inferred); product=AI tool; reference=Apple; want=pricing.

**Pass 2 (moods):** "modern", "clean", "professional" — all vague. "Like Apple" is real but Apple has three very different aesthetics (apple.com landing, apple.com/pro for creators, Apple HIG for apps). "Some sections" is not a section list.

**Output:**

```
## Spec (partial)
- Kind:           landing                                  (inferred)
- Audience:       ??? — "AI tool" could mean prosumer or enterprise
- Direction:      candidates: modern-minimal OR editorial-monocle
                  "Like Apple" = which Apple? landing.apple.com (clean tech), apple.com/pro (editorial-dark), or HIG (system-ui app feel)?
- Sections:       hero, ??? , pricing, footer                (you said "some sections" — need the list)
- Density:        balanced                                   (default; will refine after direction)
- Fidelity:       production-ready                           (default)
- Voice:          direct, calm                               (default for "professional")

## Three questions
1. Audience — who buys it? Consumers paying $9/mo, prosumers paying $49/mo, or teams paying $499/seat? Different copy, different pricing layout.
2. "Like Apple" — pick one: (a) apple.com landing — light, clean, oversized images; (b) apple.com/pro — dark, editorial, type-led; (c) Apple HIG — clean app UI.
3. Sections between hero and pricing — pick from: problem framing, three feature blocks, customer logos, testimonials, FAQ. The default landing template uses all five; you may want a tighter set.
```

---

## Anti-patterns

- **Don't conflate "premium" with a direction.** Premium is a feeling that maps to two or three directions. Ask which.
- **Don't silently pick a font.** If the user said "modern font", that's not "Inter". Surface candidates: Inter, Geist, IBM Plex Sans, Söhne — let them pick or fall back.
- **Don't backfill the section list without saying so.** If the user named three sections and you splice in three more, name the addition: "Adding problem framing, proof, and footer — common defaults; say if you'd rather drop any."
- **Don't ask seven questions.** If your clarifying list is longer than three, you missed something the user actually said. Re-read.
- **Don't ask any questions for tweaks.** "Make the hero bigger" goes straight to surgical edit. Brief-parser is for paragraphs, not tweaks.
- **Don't paste the locked spec into the artifact's HTML.** The spec lives in chat; the artifact lives in `index.html`. Keep them separate.
