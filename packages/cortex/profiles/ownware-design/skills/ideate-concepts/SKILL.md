---
name: ideate-concepts
description: 'Generate and prune a slate of concept directions BEFORE picking one to build. Use when the brief is open ("design something for…", "we need a concept for…") or when the user explicitly asks to explore options. Do NOT use for in-flight artifacts that already have a direction — that is discovery + artifact. Do NOT use for surgical edits to an existing file.'
trigger: /ideate-concepts
---

# Ideate Concepts — 12 wide, 4 sharp, 1 chosen

## Overview

Discovery picks a visual direction from a known catalog. This skill is upstream of that — it generates the *concept itself* (the angle, the metaphor, the signature move) when the brief is genuinely open. End state: the user picks ONE concept; you hand off to `discovery` for direction selection or straight to `artifact` if the direction is already obvious from the chosen concept.

If the user has already named the concept ("a landing page that looks like a terminal", "a pricing page that reads like a museum wall label"), skip this skill and go to `discovery`.

---

## Critical Constraints — read these first, every time

1. **Generate 12 concepts on the first pass, not 3.** Three is the surfacing count for the user; twelve is the generation count for you. Cutting from twelve catches the lazy first ideas. Anything fewer than twelve produces a slate that looks safe.
2. **Use SCAMPER as the generator, not free association.** Each of the 7 SCAMPER moves yields 1–3 concepts. Free association produces variants of the same idea five different ways.
3. **Score every concept on three axes before cutting.** Feasibility (1–5), Brand-fit (1–5), Novelty (1–5). Sum to a total. The bottom 8 die. The top 4 advance.
4. **Pressure-test the top 4 with the worst-case question.** For each surviving concept, write one sentence: "the worst-case rendering of this is…". If you can't name a bad version, you don't understand the concept yet. Go back.
5. **Surface only the top 3 to the user.** Three is the count the user can actually compare. Four is mush. Five is a wizard. Hold the fourth in your pocket in case the user rejects two of the three.
6. **End with a single sentence asking which one — or asking for a remix.** Don't list pros and cons for each. Don't ask the user to score them. Let them point.

---

## SCAMPER — the generator framework

For every brief, walk these seven moves in order. Each move asks a different question of the brief and surfaces concepts you wouldn't reach by free association.

- **S — Substitute.** What if the dominant element is a different element? (e.g. a landing page where the "hero" is a single quote from a customer, not a product shot.)
- **C — Combine.** What two genres / mediums / formats does this brief sit between, and what happens if you fuse them? (e.g. a pricing page + a tasting menu; a dashboard + a magazine spread.)
- **A — Adapt.** What does an *adjacent industry* do for this same problem, and what does its version look like? (e.g. how would a luxury hotel website do "B2B onboarding"? How would a museum do "developer docs"?)
- **M — Modify (Magnify / Minify).** What if one element is 10× bigger, or 10× smaller, than convention? (e.g. a hero headline at 240px; a logo at 12px.)
- **P — Put to other use.** What if the artifact does double duty? (e.g. a landing page that doubles as a system status display; a pitch deck that doubles as the product roadmap.)
- **E — Eliminate.** What if the *most expected* element is missing entirely? (e.g. a landing page with no hero image; a dashboard with no charts.)
- **R — Reverse.** What if the page reads in the opposite direction from convention? (e.g. pricing top to bottom expensive→cheap, not cheap→expensive; bottom-up storytelling.)

Each move yields 1–3 concepts. Twelve total. Write each one as a single sentence: "Concept N: <one-line elevator pitch + signature move>."

---

## The 3-axis scoring rubric

After the twelve are written, score each on:

- **Feasibility (1–5)** — can this be rendered cleanly as a self-contained HTML artifact in one pass? A concept that needs a backend, custom 3D, or assets we don't have scores low. A concept that's mostly CSS + inline SVG scores high.
- **Brand-fit (1–5)** — does this match the audience and the polish budget named in the brief? A brutalist concept for a fintech compliance landing page scores low. The same concept for a streetwear brand scores high.
- **Novelty (1–5)** — does this go past the obvious? "B2B SaaS landing page with hero + 3 features + CTA" scores 1. "B2B SaaS landing page styled as a maintenance log" scores 4.

Sum to a total out of 15. Anything ≤ 8 dies. Anything ≥ 11 advances automatically. The middle band is judgment.

**The worst-case pressure test.** For each of the top 4, write one sentence: "the worst-case rendering of this is X." If the worst case is genuinely bad (cringeworthy, off-brand, unreadable), demote the concept. If you can't imagine a worst case, you haven't thought about the concept hard enough yet — go back and write it.

---

## Concrete examples

### Brief A — "Landing page for an AI agent OS aimed at indie developers"

12 concepts via SCAMPER (compressed to titles + signature moves):

1. **S — Hero is a live terminal.** Replace the product screenshot with a typing terminal that demos a real prompt.
2. **S — Hero is a quote from a beta user.** No product mention above the fold.
3. **C — Landing × technical changelog.** Page reads top-down as a versioned release post.
4. **C — Landing × a tweet thread.** Each section is a numbered tweet card.
5. **A — Adapt indie game launch page.** Big trailer block, single price, "wishlist" CTA energy.
6. **A — Adapt indie magazine.** Editorial column layout, named author, body-first.
7. **M — Magnify the install command.** The single biggest element on the page is `npm install <thing>`.
8. **M — Minify the marketing copy to one paragraph.** Everything else is screenshots.
9. **P — Landing page doubles as the docs landing page.** Section 4 onward IS the docs index.
10. **E — Eliminate the hero entirely.** Page opens straight on the features grid.
11. **E — Eliminate features list.** Three screenshots with captions, then CTA.
12. **R — Reverse pricing order.** Top of page shows the most-expensive tier first.

Score and cut. Surviving top 4 (totals shown):

- #1 Terminal hero — F4 / B5 / N4 = **13** ✓
- #3 Landing × changelog — F4 / B4 / N5 = **13** ✓
- #7 Magnify install command — F5 / B4 / N4 = **13** ✓
- #6 Indie magazine — F3 / B3 / N5 = **11** ✓

Worst-case pressure-test:
- Terminal hero worst case = "looks like every CLI tool landing page from 2018." Mitigation: the terminal demos a specific multi-step prompt unique to this product, not a generic `--help`.
- Changelog worst case = "reads as boring text." Mitigation: alternate text blocks with screenshots; treat as visual rhythm not literal changelog.

Surfaced to user (top 3):

> Three concept directions for an indie-developer agent OS landing:
>
> 1. **Live terminal hero** — replace the product shot with a typing terminal demoing a real prompt. Honest about what the product does in 8 seconds.
> 2. **Changelog landing** — page reads as a versioned release post, top-down. Signals "we ship" before it sells anything.
> 3. **Install-command-as-hero** — single biggest element is `npm install <thing>`. Brutal, indie-confident, no marketing varnish.
>
> Which one — or remix two of these?

### Brief B — "Brand sheet for a college-student fintech app"

12 concepts (compressed):

1. **S — Replace logo with a glyph.** Single-character mark.
2. **S — Replace photo references with screenshots.** Brand IS the product.
3. **C — Brand sheet × ID card.** Each color/type rule is a row on a student ID.
4. **C — Brand sheet × dorm-room poster.** Tactile, screenprinted feel.
5. **A — Adapt skate-deck brand book.** Aggressive type, two-color rule.
6. **A — Adapt thrift-store receipt.** Monospace, density, faint background.
7. **M — Magnify the wordmark.** Wordmark fills the page; everything else is a footnote.
8. **M — Minify the palette to two colors.** No grays. Two hexes.
9. **P — Brand sheet doubles as the welcome email.** Each section ends with a CTA.
10. **E — Eliminate photography.** Pure type + color, no imagery.
11. **E — Eliminate the dark mode.** Single-mode brand.
12. **R — Reverse: start with voice, end with logo.** Tone-first brand sheet.

Score → top 4 → top 3 surfaced. Same pattern.

---

## Anti-patterns

If you find yourself reaching for "three safe options", stop. The whole point of this skill is that the unsafe options come from process, not from courage. Walk SCAMPER first.

If you find yourself describing each concept in three paragraphs to the user, stop. One sentence per concept. The user picks fast or asks for a remix; they don't read essays.

If you find yourself scoring every concept a 4 or 5, stop. Your scoring is broken. Re-score with the worst-case question explicitly in mind. Most first-pass concepts are 2s and 3s — that's why we cut.

If the brief is genuinely closed ("rebuild this exact Linear-style landing page"), do not run this skill. Go to `discovery` for direction, then `artifact`. Ideation on a closed brief wastes the user's turn.

If after twelve concepts you haven't found a top 4 that all score ≥ 11, the *brief* is too thin. Surface that honestly: "Brief gives me twelve concepts that all sit at 9 or below — what's the constraint I'm missing?" Don't pad the slate with weak options.
