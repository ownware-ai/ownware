---
name: swiss-research-video
description: 'Design spec for Swiss-style user-research video frames. 1920×1080 slide-style frames each holding 3–5 seconds, white background, Helvetica/Inter only, one teal accent, each frame = one quote + one stat. Use when the brief is a research-findings video (interview synthesis, usability test recap, customer-insight reel). Skip for live decks (use /swiss-international-deck) and Remotion rendering (that''s /video-renderer — this is the frame design spec it consumes).'
trigger: /swiss-research-video
---

# Swiss Research Video — frame-by-frame design for research-findings videos

## Overview

This skill writes the DESIGN spec — frame composition, type sizes, palette, animation cues — for a research-findings video. It does NOT write the Remotion project; that's `/video-renderer`, and it consumes the spec this skill produces. Use this when the user asks "I have research findings, make me a short video that walks through them."

The aesthetic: white paper, Helvetica or Inter, one teal accent (Ownware's `#00D4AA`), each frame holds for 3–5 seconds with subtle fade transitions. Reads like a Müller-Brockmann poster animated frame by frame.

---

## Critical Constraints — read these first, every time

1. **Canvas is 1920×1080, 30fps, white background `#ffffff` always.** No dark mode. No off-white "paper" — pure white is the Swiss research convention.
2. **Type stack is exactly `Helvetica Neue, Inter, system-ui, sans-serif`.** No serifs. No display fonts. Numerals: `font-variant-numeric: tabular-nums`.
3. **One accent: teal `#00D4AA`** (Ownware token). Used on: the stat, the highlighter underline, the section index dot. Nowhere else. Body text is `#0a0a0a`; muted is `#6b6b6b`; rule lines are `#e5e5e5`.
4. **Each frame holds 3–5 seconds.** Below 3s the viewer cannot read the quote; above 5s the video drags. Stat-only frames lean 3s; quote-heavy frames lean 5s.
5. **One frame = one quote + one stat.** Not two quotes. Not three stats. Splitting forces the viewer to choose what to read; we made the choice.
6. **Transitions are fades (300ms ease-in-out) or hard cuts only.** No slides. No spins. No "creative" transitions — they fight the editorial discipline.
7. **Type sizes are fixed across the spec.** Index `28px / +0.18em uppercase`. Quote `64px / 1.15 / -0.01em / weight 400`. Attribution `22px / 1.3 / weight 500 / muted`. Stat `200px / 0.92 / -0.04em / weight 700`. Stat caption `26px / 1.3 / weight 500 / uppercase / +0.08em`.

---

## Frame anatomy — what every frame holds

Five regions, every frame:

1. **Section index** — top-left, `28px`, format `01 / 05 · INTERVIEW SYNTHESIS`. Always present. The teal dot precedes the number.
2. **Quote block** — center-left, 60% width. `64px` regular weight, max 3 lines, `text-wrap: balance`. A teal `4px` underline sits under the load-bearing phrase.
3. **Attribution** — directly under the quote, `22px` muted, format `— Maya, design lead, fintech, 8-yr ICUS`.
4. **Stat panel** — right column, 30% width. Big number `200px` weight 700, caption `26px` uppercase underneath.
5. **Footer hairline** — `1px` `#e5e5e5` rule, 96px from bottom, full width minus 96px margins.

Frame margins: 96px outer on all sides.

---

## Frame timing & sequence rules

- **Frame 1 is the title frame.** Holds 4s. Big title + project name + research method + cohort size. No quote yet.
- **Frames 2 through N-1 are quote-stat frames.** Each holds 4s; subtract 0.5s for short quotes, add 0.5s for 3-line quotes.
- **Final frame is the synthesis card.** Holds 5s. 3 takeaway bullets (32px regular) plus the call-to-read-more URL.
- **Fades between frames are 300ms.** A 5-frame video at 4s per frame plus 4×300ms fades = 21.2s total. Round up to 22s for the export.
- **Audio is optional.** When present, music ducks 6 dB under voiceover; voiceover reads the quote verbatim. When silent, the type holds longer (5s per frame).

---

## Concrete examples — a 5-frame research-findings video spec

Project: 8 user interviews with mid-market design leads. Question: "How are you using AI in your design workflow today?" Below is the full spec the agent hands to `/video-renderer`.

### Frame 01 — Title (hold 4s)

- **Index:** `01 / 05 · INTERVIEW SYNTHESIS` (top-left)
- **Title:** `Where AI lives in the design workflow.` (96px, weight 600, two lines balanced)
- **Method strip:** `8 interviews · design leads · 60-min remote · April 2026` (24px muted, 32px below title)
- **No quote, no stat.** Clean cover frame.

### Frame 02 — "It saved me an hour but I rewrote half of it." (hold 4s)

- **Index:** `02 / 05 · TIME SAVED VS. TIME SPENT REVIEWING`
- **Quote:** `"It saved me an hour but I rewrote half of it. Net win is maybe twenty minutes."` — teal underline under `Net win is maybe twenty minutes`.
- **Attribution:** `— Maya, design lead, fintech, 8 yrs`
- **Stat:** `5/8` (200px) · caption `LEADS WHO REWROTE > 30% OF AI OUTPUT`

### Frame 03 — "I trust it for boilerplate, not for thinking." (hold 4s)

- **Index:** `03 / 05 · WHERE TRUST LIVES`
- **Quote:** `"I trust it for boilerplate, not for thinking. The moment it starts proposing a structure, I close the tab."` — teal underline under `closes the tab`.
- **Attribution:** `— Jonas, principal IC, B2B SaaS, 12 yrs`
- **Stat:** `7/8` (200px) · caption `LEADS WHO USE AI FOR FIRST-DRAFT COPY`

### Frame 04 — "The team chat is where the real work happens." (hold 4.5s)

- **Index:** `04 / 05 · AI BELONGS WHERE THE WORK IS`
- **Quote:** `"The team chat is where the real work happens. An AI that lives in Figma isn't where I am at 3pm on a Thursday."` — teal underline under `lives in Figma isn't where I am`.
- **Attribution:** `— Priya, head of design, marketplace, 6 yrs`
- **Stat:** `6/8` (200px) · caption `WANT AI IN SLACK OR LINEAR, NOT THE CANVAS`

### Frame 05 — Synthesis (hold 5s)

- **Index:** `05 / 05 · WHAT WE TAKE FORWARD`
- **No quote.** Three bullets, 32px regular, 1.5 line-height, teal `•` markers:
  - Treat AI output as boilerplate, not as structure. The agent never owns the frame.
  - Surface the agent where the team already coordinates — chat first, canvas second.
  - Measure net minutes saved, not generation count. Track rewrites.
- **CTA:** `Read the full synthesis — ownware.dev/research/ai-in-design` (28px, weight 500, teal)

Total runtime: 21.5s clip + 0.3s fades.

---

## Workflow

1. **Collect 4–8 highlighted quotes from the user.** Refuse to fabricate research; the quotes are the source of truth.
2. **Pair each quote with one stat from the same dataset.** If there's no quantitative pair, leave the stat panel blank and resize the quote to occupy the full row.
3. **Order frames by argument, not by interview order.** Strongest opener, contrasting middle, synthesis last.
4. **Write the spec as a single markdown file** (`research-video-spec.md`) plus a thumbnail HTML preview (`frame-previews.html`) showing all frames as static cards in a vertical stack. The user reviews the static stack, signs off, then `/video-renderer` consumes the spec.
5. **Hand the markdown spec to `/video-renderer` for Remotion rendering.** The spec → Remotion file mapping is 1:1 (one frame per Remotion `<Sequence>`).

---

## Anti-patterns

- **Two quotes per frame.** Forces a choice the viewer doesn't have time to make. One quote, one frame.
- **A stat that doesn't anchor to the same finding as the quote.** Then the panel reads as decoration, not evidence. Cut the panel; widen the quote.
- **Underlining the whole quote in teal.** The underline is a highlight, not a decoration — one phrase per frame.
- **Drop-shadow / glow / gradient on the type.** Swiss research video is naked Helvetica on white. Effects belong in `/poster-design`.
- **Cutesy transitions (slide, spin, dissolve).** Breaks the editorial discipline. Fade or hard cut, nothing else.
- **Filling the stat panel with a number when there isn't a real one.** Leave it empty before you fake it. "8/8 leads loved it" is a lie if you only asked 4.
