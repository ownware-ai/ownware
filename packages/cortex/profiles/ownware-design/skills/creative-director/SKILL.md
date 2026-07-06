---
name: creative-director
description: 'High-bar creative review that scores a concept or near-final artifact against awards-grade craft (Cannes / D&AD / Pentagram bar). Use when the user asks for a "creative director review", when an artifact is about to go to a stakeholder presentation, or before a brand-defining piece ships. Do NOT use for routine craft polish — that is /critique. Do NOT use for early concept generation — that is /ideate-concepts.'
trigger: /creative-director
---

# Creative Director — the harder bar above /critique

## Overview

`/critique` scores the 5 dimensions of CRAFT (hierarchy, rhythm, contrast, consistency, craft). That bar catches sloppy work. This skill applies a HIGHER bar: does the artifact have a POINT OF VIEW worth defending in front of a room? Use it before brand-defining work ships. Do not use it on every artifact — it's an expensive review, and 80% of artifacts don't need it.

The deliverable is a 3-axis score (Idea / Execution / Craft) plus a "kill or keep" verdict, plus the one structural change that would lift it most.

---

## The Framework — 3 axes, scored 1–5, defended in writing

1. **Idea (I)** — Is there a *single defensible thesis* a stranger could repeat after one viewing? "It's a clean B2B landing page" is not a thesis. "The hero treats the install command as a manifesto" is. A 5 means the idea is sharp enough that you'd defend it in a room. A 1 means there is no idea — it's a competent layout with no point of view.
2. **Execution (E)** — Does the artifact deliver on its own idea? An artifact with a sharp idea but a generic execution scores low here. A landing page that promises "terminal aesthetic" but renders as cobalt buttons on white scores 2 on Execution regardless of how good the rest looks.
3. **Craft (C)** — The `/critique` dimensions (hierarchy, rhythm, contrast, consistency, craft details) compressed to one axis. A 5 here means awards-bar craft. A 3 means it ships but a designer would wince.

Each axis 1–5. Sum to a total out of 15. Verdict thresholds:
- **13–15: SHIP.** This is the bar. Go.
- **10–12: ITERATE.** The idea is alive; one targeted pass lifts it. Name the one move.
- **7–9: RETHINK.** Either the idea or the execution is structurally off. Don't polish; reset.
- **≤6: KILL.** No salvage. The concept itself is wrong. Go back to `/ideate-concepts`.

---

## Critical Constraints

1. **Score IDEA before you score craft.** If Idea is ≤ 2, Craft doesn't matter — a perfectly-crafted artifact of no idea is wallpaper. Lead with idea on every review.
2. **Defend each score in one sentence with one piece of evidence.** "Idea: 4 — the install-command-as-hero gives the page a defensible thesis you can repeat: 'we ship for terminal natives.'"
3. **Name ONE structural change, not a list.** Creative direction is the discipline of picking the highest-leverage move. If you list five changes, the user does none of them. Pick the one that lifts the whole piece.
4. **Reference the rubric, not personal taste.** "I'd prefer green" is not creative direction. "The current palette undercuts the thesis because cobalt reads as B2B-safe and the thesis is indie-confident — try a hotter color" is.
5. **Always state the verdict in plain English.** SHIP / ITERATE / RETHINK / KILL. The user gets one of four words. Don't soften.
6. **Use `web_search` and `web_fetch` if you need a reference.** Real reference, real URL. Don't reach for memory of "what Stripe does" — go check what Stripe actually does this week.

---

## The Five-Phase Review Process

Walk these in order. Each phase has a question you answer before moving on.

### Phase 1 — Brief recall (30 seconds)

State the brief back in one sentence — audience, format, signal. If you can't, ask the user what the brief was. Do not score an artifact whose brief you don't know.

### Phase 2 — First-impression read (60 seconds)

Look at the rendered artifact for 60 seconds. Write the *first three things* you noticed, in order. This is the user's first 60 seconds; it's the closest you'll get to a fresh-eyes read.

### Phase 3 — Idea axis (the load-bearing one)

Answer: "What is the single thesis a stranger could repeat?" Write it in one sentence. If you can't write it, score Idea: 1 or 2.

A 5 on Idea has all four:
- A defensible angle (not just a layout choice).
- A signature move (one element that crystallizes the angle).
- Audience fit (the angle is sharp for the named audience, dull for everyone else — that's a feature).
- Compression (the thesis fits in a tweet).

### Phase 4 — Execution axis

For the thesis from Phase 3, ask: "What in the artifact carries this thesis?" If the answer is "the headline copy", Execution is at most a 2 — copy alone isn't execution. Execution is *visual moves* that carry the idea: type choice, palette choice, density, signature element placement, micro-interactions.

Score 5 if every region reinforces the thesis. Score 3 if half does. Score 1 if none does (idea lives only in the brief, not in the file).

### Phase 5 — Craft axis + verdict

Compress the `/critique` 5 dimensions to a 1–5 on Craft. Then state Total, Verdict, and the ONE move.

---

## Concrete examples

### Example A — Indie-developer landing, near-final pass

```
Brief: Landing page for indie-dev AI agent OS. Audience: skeptical indie devs.

First 3 noticed:
1. Big install-command block above the fold.
2. Three thin feature rows below.
3. Stripe-style cobalt buttons.

Idea: 4 — the install command as hero gives a defensible thesis: "we ship for terminal natives, not for buyers." Sharp angle for the audience.

Execution: 2 — the cobalt button palette undercuts the thesis. Terminal-natives don't see Stripe cobalt and feel "yes, this is for me." They see "B2B sales page that wants my CTO to sign." The hero earns the idea; everything below it dilutes.

Craft: 4 — hierarchy is clean, rhythm consistent, contrast AA. Hover states present. Falls short of 5 because the cobalt accent is the most-noticed color and it's pulling the wrong direction.

Total: 10/15
Verdict: ITERATE
ONE move: Swap --accent from cobalt #2f6feb to a terminal-green #00d26a (or a hot amber). This single token change makes Execution jump from 2 to 4 — every button, link, focus ring, and chart line now reinforces "terminal natives." Do nothing else this pass.
```

### Example B — Pitch deck, brand-defining moment

```
Brief: Seed pitch deck for a consumer health company. Audience: seed VCs.

First 3 noticed:
1. Stock-photo-y hero on slide 1.
2. Headline "Reimagining Healthcare" on slide 2.
3. Bar chart slide 4 with no annotation.

Idea: 1 — there is no thesis. The deck reads as a generic "healthcare startup" template. A stranger would not be able to repeat what this company does or why it wins.

Execution: 2 — the visual choices are conventionally "healthcare-y" (stock photos, soft blues) but they don't carry a thesis because there is no thesis to carry.

Craft: 3 — hierarchy okay, rhythm okay, but slide 4's bar chart has no callout, no annotation, no "the surprising thing is X."

Total: 6/15
Verdict: KILL — go back to ideate-concepts.
ONE move: Don't polish this deck. The reset is at the concept level. Spend a turn in /ideate-concepts to find the ONE thing this company does that no other consumer health pitch claims. Build the deck around that single claim. Stock photos and "Reimagining Healthcare" headlines are the symptom; the absence of a defensible angle is the disease.
```

---

## Anti-patterns

If you find yourself listing 5 things to fix, stop. That's `/critique`. Creative-director output is ONE move. Pick the highest-leverage one and let the others wait.

If you find yourself scoring everything a 3, stop. A 3 across the board means you haven't formed an opinion. Re-read with the brief in mind and force yourself to score 1–2 or 4–5 on at least one axis.

If your "ONE move" is "polish the typography", stop. That's a /critique move, not a creative-director move. Creative-director moves change the IDEA or its EXECUTION — palette swap, signature-element placement, structural region replaced. Type polish is downstream.

If you reach a SHIP verdict on the first review of a first draft, you scored wrong. First drafts almost never ship from creative-director review; that's the whole point of having the bar above `/critique`. Re-score with more honesty.

If the user disagrees with your verdict, do not capitulate. State the rubric reasoning once more, plainly, and offer: "If you ship as-is, here's what I'd watch for in the audience's reaction…" Then let them decide. Creative direction is opinion, defended; it is not voting.
