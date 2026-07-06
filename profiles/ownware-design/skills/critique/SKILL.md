---
name: critique
description: 5-dimensional self-audit run BEFORE declaring an artifact done, and the surface for reviewing an existing URL or pasted HTML. Scores hierarchy, rhythm, contrast, consistency, and craft 1–5 with one sentence of evidence each. Fixes anything ≤ 3 surgically before handoff. Use after every artifact build; use whenever the user asks "review this".
trigger: /critique
---

# Critique — 5 dimensions, honest scores

## Overview

Every artifact passes through critique before handoff. The user reviews the result, not the intent — so the agent's job is to catch its own weak moves *before* presenting them. This skill encodes the discipline.

Two modes:

- **Self-critique** (post-build, default): you just wrote the artifact. Before saying "done", run the five dimensions on your own work. Fix anything ≤ 3.
- **External critique** (on demand): the user pasted a URL or HTML and asked for a review. Same five dimensions, but the deliverable is a prioritised fix list — not a rewrite — unless the user asked you to fix.

---

## Critical Constraints — read these first, every time

1. **Honest scores or no scores.** If every dimension comes back 5/5 on a first draft, your critique is broken, not your artifact. Re-read with fresh eyes.
2. **Evidence per dimension.** One sentence per score, naming the specific thing you saw or didn't see. "Hierarchy: 3 — hero, first feature row, and CTA are all the same visual weight; nothing pulls the eye first."
3. **Fix anything ≤ 3 before declaring done.** That's the bar. A 4 might survive ("good enough for first pass"); a 3 means a real reader is going to bounce off it.
4. **Surgical fixes, not rewrites.** A 3 in *contrast* fixes with one change to a token or a type weight. A 3 in *hierarchy* fixes by raising or lowering a few sizes. If your fix is a 200-line diff, the score was wrong or the artifact was deeper-broken than 3.
5. **Report scores in your reply.** When you ship the artifact, the score line is part of the handoff. "Critique: H 4 / R 4 / Co 5 / Cn 4 / Cr 4 — caught a slight rhythm break in the features row, fixed by equalising padding."

---

## The five dimensions

Read this section like a checklist. Each dimension has the question, what a 5 looks like, what a 1 looks like.

### 1. Hierarchy (H)

**Question:** Can a fresh visitor land on this artifact and tell, in three seconds, what to read first, second, third?

- **5** — A single dominant element. Secondary elements are clearly secondary by size, color, or position. Eye flow is obvious.
- **3** — Two or three elements compete. The visitor pauses; the eye doesn't settle.
- **1** — Everything is the same weight. The artifact reads like a wall of equal-importance blocks.

Common fixes: raise the hero headline 8–16px; demote a secondary CTA to a text link; remove a competing photograph; add white space to isolate the primary message.

### 2. Rhythm (R)

**Question:** Do the sections breathe at a consistent cadence — same vertical padding pattern, same gutters, same spacing between heading and body?

- **5** — Section-to-section padding is consistent (e.g. 96px desktop / 56px mobile). Heading-to-body spacing is consistent across all sections. The page has a meter.
- **3** — One or two sections feel cramped or one feels bloated. The eye notices a hiccup.
- **1** — Random padding. The page lurches.

Common fixes: standardise vertical section padding to one value (with one tighter value for dense sections); standardise heading→body distance to one value; align gutters to a 4 or 8 px scale.

### 3. Contrast (Co)

**Question:** Is text readable? Are interactive elements obviously interactive? Are semantic states distinguishable without color alone?

- **5** — WCAG AA for body text. AAA for primary CTAs. Interactive elements have a clear non-color affordance (border, underline on hover, shape). Errors and successes carry both color and icon.
- **3** — One area dips below AA — usually a `--muted` color used on `--surface` for body copy.
- **1** — Body copy is hard to read. CTAs blend in. State changes invisible.

Common fixes: darken `--muted` one step; thicken button borders to `1.5px`; add an icon next to semantic colors; never rely on color alone for state.

### 4. Consistency (Cn)

**Question:** Same component, same look, every time it appears. Same spacing in a card. Same icon weight. Same border treatment. Same hover behavior.

- **5** — Every card uses the same padding, radius, border. Every button matches the button system. Every icon uses the same stroke width.
- **3** — Two card variants drift apart (one has 16px padding, another 18px). One icon is a different stroke.
- **1** — Visual chaos. Cards look like they came from different files.

Common fixes: hoist the divergent values into the token block or into a single `.card` class; remove drift in icon sizing.

### 5. Craft (Cr)

**Question:** Are the small things right? `text-wrap: balance` on headlines? `text-wrap: pretty` on body? Letter-spacing on display? Line-height tuned per size? Focus ring? Hover state? Empty-state copy?

- **5** — Every detail considered. Reading the artifact's CSS feels like reading a designer's notebook.
- **3** — Hover states present but generic. Focus rings default. Line-heights at one global value.
- **1** — No hover. No focus. Body line-height at 1 (line-cramped) or 1.8 (line-airy). Headlines wrap awkwardly.

Common fixes: add `text-wrap: balance` to every h1/h2; tune `letter-spacing: -0.01em` on display sizes ≥32px; add a `:focus-visible` outline using `--accent`; tune `line-height: 1.5` on body and `1.2` on headings.

---

## Self-critique workflow (post-build, default)

After writing the artifact and *before* declaring done:

1. **Read the artifact in the preview.** Do not rely on the CSS. Look at the rendered result.
2. **Score each dimension out loud (in your head or in your reasoning), with one sentence of evidence.** Be honest. If something feels off, name it.
3. **List the fixes.** For each score ≤ 3, the one-line fix.
4. **Apply the fixes surgically.** Edit the right `data-od-id` region, or the right CSS rule, or the right token. No wholesale rewrites unless craft is ≤ 2 across the board.
5. **Re-score.** All five should be ≥ 4 before handoff.
6. **Report the scores in your reply.** One line: `H 4 / R 5 / Co 4 / Cn 5 / Cr 4`. If you fixed something, say what.

If you cannot get every dimension to ≥ 4 in two passes, *say so to the user* — don't just keep grinding. Sometimes the brief is at fault (e.g. the direction is wrong for the content) and the right move is to ask, not to polish a fundamentally-misaligned artifact.

---

## External critique workflow (on-demand)

When the user pastes a URL or HTML and asks for a review:

1. **Read it carefully.** Don't skim; the score depends on noticing real moves, not pattern-matching.
2. **Score all five dimensions, with evidence.** This is the deliverable; lead with it.
3. **List 3–7 prioritised fixes.** Each fix has: the dimension it addresses, the specific change, the expected effect. Three to seven — not fifteen. Long lists are unactionable.
4. **Stop at the fix list.** Do not start applying the fixes unless the user explicitly asks. The user picks.
5. **If asked to apply, apply surgically.** Same discipline as self-critique edits. Diff should be small. Save the original first (`*-before.html`) if you're modifying their pasted code.

External critique deliverable shape:

```
**Score**
H 3 — Hero headline and three feature cards compete; eye doesn't settle.
R 4 — Sections breathe consistently except features→proof which is too tight.
Co 5 — Body and CTAs read cleanly.
Cn 3 — Two card variants drift: 16px vs 20px padding.
Cr 4 — No `text-wrap: balance` on headlines; everything else considered.

**Fixes (prioritised)**
1. (H) Raise hero headline from 48 → 64px; demote secondary CTA to a text link. — pulls the eye to a single primary action.
2. (Cn) Hoist `.card` padding into one rule at 18px; remove the per-card overrides. — kills the drift.
3. (R) Add 24px to features→proof spacing to match the section meter.
4. (Cr) Add `text-wrap: balance` to h1, h2.
5. (Cr) Add `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`.
```

That's the shape. Then ask: "Want me to apply the top three?"

---

## A note on the score floor

These five dimensions are necessary, not sufficient. A 5/5/5/5/5 artifact can still be wrong: it can be on the wrong brief, the wrong audience, the wrong direction. Critique is not the same as fit. Fit is the user's call — the agent's call is craft. Score honestly, fix what you can, and leave the brief-and-fit conversation to the user.
