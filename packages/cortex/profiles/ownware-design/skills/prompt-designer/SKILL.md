---
name: prompt-designer
description: Turn a fuzzy natural-language design brief into a structured 150-300 word design-spec-rich prompt the agent feeds into its own writeFile loop for the actual artifact. Use when the brief is one sentence ("a pricing page that feels like Linear") or before any artifact where layout/type/motion/color decisions are otherwise implicit. Do NOT use to rewrite a brief that's already explicit and section-listed — go straight to `artifact`.
trigger: /prompt-designer
---

# Prompt Designer — fuzzy brief → structured design spec

## Overview

The agent gets briefs like "I want a pricing page that feels like Linear." That's a vibe, not a buildable spec. This skill teaches how to expand that one line into a 150-300 word **structured prompt document** that names the layout grid, type scale, color tokens, motion semantics, and component composition concretely. The agent then feeds that document into its own `artifact` writing loop — same agent, two-pass: spec, then file.

This is the bridge between `discovery` (cheap conversational locking) and `artifact` (the file-writing discipline). When discovery ends with the user nodding at a vague direction, prompt-designer is what makes the direction explicit before code is written.

The structured prompt is saved to `prompt.md` in the working folder. The agent reads it back when writing the artifact. The user can also edit it and ask for a re-run — surgical changes to the prompt produce surgical changes to the artifact.

---

## Critical Constraints — read these first

1. **150-300 words.** Long enough to be specific; short enough that re-reading is free. Sub-150 is too vague to drive a build; over-300 starts inventing constraints the user didn't ask for.
2. **Six sections, every time, this order.** Goal → Audience → Layout grid → Type scale → Color tokens → Motion → Component composition. Out of order = readers skip the bottom half. Skipping a section = under-specified.
3. **Real values, no placeholders.** Pixel sizes (`base 16px, h1 48px`), real hex (`#635bff`), real grid columns (`12-col, 80px gutter, 1240px max`). Words like "appropriate," "modern," "clean," "appropriate spacing" are banned — they tell the writer nothing.
4. **Cite the reference, name the move.** If the brief is "feels like Linear," the prompt names ONE signature move from Linear that the artifact must emulate (e.g. "narrow body column inside a wide neutral surround, gradient mesh background in the hero only"). Generic "Linear-style" without a named move is too thin.
5. **Motion has semantics, not just durations.** "Hover lifts the card 2px in 120ms with `cubic-bezier(0.23, 1, 0.32, 1)` — the easing says 'gentle attention,' not 'click me now.'" Naming the FEELING the easing creates locks the artifact's voice.
6. **Component composition lists the ACTUAL components.** Not "hero, features, CTA." It lists the parts of each: "Hero = single oversized headline (h1, 64px, balance-wrapped), one-line subheadline (24px muted), primary + secondary CTA pair, no hero image."
7. **One file, `prompt.md`, replaced on each re-spec.** Not `prompt-v2.md`, not `prompt-final.md`. Surgical edits to the same file, like the artifact pattern.

---

## The six-section template

Every prompt this skill produces follows this exact shape. Memorize the section order and the kind of value each section holds.

```markdown
# {Artifact title} — design spec

## Goal
One paragraph (2-3 sentences). What this artifact must DO for the audience.
Not "show our pricing" — "convince a senior buyer with a tight budget to
book a demo, by making the value-per-dollar of the mid tier visually obvious."
The goal drives every later decision.

## Audience
One paragraph. WHO sees this, WHEN, WHAT they bring to the page. Affects
voice, polish budget, density.
Example: "B2B procurement leads at 200-2000 person SaaS companies, arriving
from a comparison search after vetting two competitors. They are skeptical,
not curious — every element pays its way or gets cut."

## Layout grid
Concrete grid: max-width, columns, gutters, vertical rhythm unit. Example:
"12-col grid, 80px gutters, 1240px max-width container, 8px vertical
rhythm unit. Section padding 96px desktop / 56px mobile. Hero spans 8
of 12 columns, offset by 2 (a deliberate asymmetry)."

## Type scale
Display family, body family, mono family. Sizes for h1/h2/h3/body/small.
Letter-spacing on display. Line-height on body and headings.
Example: "Display: 'Inter Display', Inter, sans-serif. Body: Inter.
Mono: ui-monospace, Menlo. Scale: h1 64px / -1.5 letter-spacing / 1.05
line-height. h2 36px. Body 16px / 1.55 line-height. text-wrap: balance
on h1/h2; text-wrap: pretty on body."

## Color tokens
Full :root block in CSS. Surfaces, fg, muted, border, accent, accent-fg,
semantic (good/warn/bad). Hex only.
Example: "--bg #fafafa, --surface #ffffff, --fg #0a0a0a, --muted #6b7280,
--border #e5e7eb, --accent #635bff (Linear purple), --accent-fg #ffffff,
--accent-soft rgba(99,91,255,0.08), --good #17a34a, --bad #dc2626."

## Motion
What animates, when, with what duration and easing, and WHY (the feeling).
Example: "Buttons: hover lifts 2px in 120ms cubic-bezier(0.23,1,0.32,1) —
gentle attention. Cards: hover raises border opacity from 0.4 → 1 in 180ms
— acknowledged, not aggressive. Page transitions: none (this is a static
landing). Reduce-motion: respect prefers-reduced-motion, disable lift."

## Component composition
Per region of the page: the components and their content. NOT just
section names; the actual parts. Example:
- Hero: h1 ("Ship faster"), subheadline (24px muted, "The issue tracker
  built for speed"), CTA pair (primary "Start free" + secondary "Watch
  demo"), no image. Background: subtle radial gradient mesh, accent at
  20% opacity, fades to transparent in 600px.
- Pricing tiers: 3 cards. Middle card raised (border 1px accent, badge
  "Most popular"). Each card has tier name, monthly price, 5-line
  feature list with check-icons, single CTA. Same padding (28px),
  same height (forced equal min-height).
- Footer: 4-column link grid, brand mark + copyright, one row of
  social icons. Muted on muted surface.
```

That's the whole structure. Goal anchors WHY. Audience anchors VOICE. Layout anchors STRUCTURE. Type/color/motion are the SYSTEM. Composition is the BUILD ORDER.

---

## Vocabulary the agent must reach for

When writing prompts, the agent uses **real design vocabulary**, not soft hedging words. Below is the controlled vocabulary — the right side is what the agent should write, the left side is what NOT to write.

| Vague (don't write)         | Specific (write this)                                                |
|----------------------------|----------------------------------------------------------------------|
| "modern font"              | "Inter Display for h1/h2, Inter for body"                            |
| "nice spacing"             | "8px vertical rhythm; section padding 96/56"                         |
| "subtle animation"         | "120ms / cubic-bezier(0.23,1,0.32,1) — gentle attention"             |
| "good contrast"            | "WCAG AA body, AAA on primary CTAs"                                  |
| "clean layout"             | "12-col 1240px container, 8 of 12 hero spans"                        |
| "Linear-style"             | "narrow body column in wide neutral surround, mesh gradient hero"    |
| "modern colors"            | "single saturated accent on near-white surface, semantic on gray-50" |
| "card design"              | "1px border at 0.4 opacity, 16px radius, 28px padding, no shadow"    |
| "professional"             | "low chroma, high legibility, no decorative type"                    |
| "fun"                      | "1 accent hue, 1 contrasting accent for highlights, oversized type"  |

If the brief contains a vague word, the prompt **replaces** it with the specific version. The user can push back if the specific version isn't what they meant — that pushback is more productive than them seeing a generic artifact later.

---

## Concrete examples — two full prompts

### Example 1 — "a pricing page that feels like Linear"

User: "I want a pricing page that feels like Linear."

Agent writes `prompt.md`:

```markdown
# Pricing page — design spec

## Goal
Convince a senior developer-tools buyer at a mid-market SaaS team that the
$24/mo middle tier is the obvious choice. Frame it as the default, not as
"the upsell." Reduce decision time on the page to under 60 seconds.

## Audience
Engineering managers at 50-500 person SaaS companies, arriving from a
"linear vs jira vs shortcut" comparison search. They are technical, skim-
heavy, and skeptical of marketing flourish. They will judge the page in
about 8 seconds.

## Layout grid
12-col, 80px gutters, 1180px max-width container. 8px vertical rhythm
unit. Section padding 96px desktop / 56px mobile. Pricing card row spans
12 of 12 (full container width), divided into 3 equal cards with 24px
inter-card gap.

## Type scale
Display: "Inter Display", Inter, sans-serif. Body: Inter. Mono: ui-monospace,
Menlo. h1 48px / -1.2 letter-spacing / 1.1 line-height. h2 28px. Body 16px /
1.55 line-height. Card price 56px / -2 letter-spacing / tabular-nums.
text-wrap: balance on h1/h2.

## Color tokens
--bg #fafafa, --surface #ffffff, --fg #0a0a0a, --muted #6b7280,
--border #e5e7eb, --accent #5e6ad2 (Linear purple),
--accent-soft rgba(94,106,210,0.08), --accent-fg #ffffff,
--good #17a34a, --warn #eab308, --bad #dc2626.

## Motion
CTA buttons: hover lifts 2px and gains a 1px accent ring in 120ms
cubic-bezier(0.23,1,0.32,1) — gentle attention. Middle card has a 1.5px
accent border permanently — no hover lift (it's already selected by
default). Reduce-motion: drop the lift, keep the ring.

## Component composition
- Topnav: brand mark left, 4-item nav center, "Sign in" + "Start free"
  pair right. Sticky at top, white surface with 1px border-bottom on scroll.
- Hero: h1 "Simple pricing, scale on your terms", subheadline 18px muted,
  no CTA (the cards are below). 64px padding bottom.
- Pricing row: 3 cards (Free / Team / Enterprise). Team card has badge
  "Most popular" pill above name, accent-tinted background (accent-soft).
  Each card: tier name (h3 20px), price (56px), monthly/annual toggle
  resolved to monthly here, 6-line check-list of features, primary CTA.
  Same min-height across all three.
- FAQ: 6 questions in single-column accordion. h4 18px headings, 16px
  muted body when expanded. Plus/minus icon right-aligned.
- Footer CTA: full-bleed accent-soft background, h2 "Start with Free",
  one primary CTA, one secondary text link.
```

### Example 2 — "a Friday-update email for the team, monospace feel, link-heavy"

User: "I want to send a Friday team update — make it feel like an old-school engineer's email, monospace, link-heavy, short."

Agent writes `prompt.md`:

```markdown
# Friday team update — design spec

## Goal
A weekly status email an engineer would actually read. Lead with what
shipped, link to evidence (PRs, dashboards), end with what's next.
Should feel like a senior engineer's notebook — terse, factual, no fluff.

## Audience
12-20 engineers and PMs in our team. They will read it on phone or in
terminal-style mail client. Skim time: 30 seconds.

## Layout grid
Single column, 640px max-width (email-safe), centered on a neutral
background. 16px outer padding inside the container. No grid; line-by-line.

## Type scale
Body: ui-monospace, "JetBrains Mono", Menlo, monospace. Single size: 14px.
Headings are h2 17px bold, no separate display font. line-height 1.55.
text-wrap: pretty. Numbers: tabular.

## Color tokens
--bg #f4f1ea (paper), --surface #ffffff, --fg #1a1a1a, --muted #6b6b6b,
--border #d6d0c4, --accent #cf5b1d (rust), --accent-fg #ffffff,
--link #1f4ed8 (classic blue, underlined).

## Motion
None. This is an email — no animation, no transitions. Links underline on
hover for any web preview but the email itself is static.

## Component composition
- Header strip: small label "FRIDAY UPDATE — WEEK 21" (12px muted
  uppercase, letter-spacing 0.1em), date below in muted 14px.
- Shipped section: h2 "Shipped this week", then 5-7 single-line items.
  Each item: a one-line description ending with one or two inline links
  in --link color, underlined.
- Numbers section: h2 "Numbers", then 3 KPI lines in monospace
  (e.g. "p95 latency  142ms  ↓ 8ms").
- Next week section: h2 "Next week", 3-5 line items, owners in
  parentheses ("Ship cohort retention — (alex)").
- Footer: one line in muted color: "Replies go to #eng-friday. — JS".
```

---

## Anti-patterns

- **Generating a prompt and immediately starting the artifact in the same turn.** Split. Prompt first, user nods (or edits), then the artifact build. Otherwise the prompt becomes invisible scaffolding the user can't course-correct.
- **Vague hedging words in the output.** "Modern," "clean," "appropriate," "professional," "nice." Every one of those is a signal to STOP and replace with a specific value. If you can't pick the specific value, the brief itself needs another discovery question — back up.
- **Inventing constraints the user didn't ask for.** If the user said nothing about animation, write `Motion: none (static page).` Don't invent a motion system because it feels designerly.
- **Citing references without naming the move.** "Feels like Linear" → name ONE Linear-specific move (narrow column, mesh gradient, purple accent, etc.). Don't just write "Linear-style" — the writer (which is also you, next turn) needs the move.
- **Skipping the goal section.** Without a goal, every later decision is unanchored. The goal is the section that resolves trade-offs.
- **`prompt-v2.md`, `prompt-final.md`, `prompt-rewrite.md`.** One file, `prompt.md`, surgical edits. Versioned files diverge silently.
