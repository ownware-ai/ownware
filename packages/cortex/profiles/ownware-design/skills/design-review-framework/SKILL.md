---
name: design-review-framework
description: 'Meta review process for "is this artifact ready to ship?" Run when a stakeholder hands over a finished design and asks for a go/no-go. 6 dimensions scored 0-10 with prescriptive blocker thresholds, an AI-slop signal sweep, and a prioritised fix list. For tactical mid-build self-critique of one artifact in front of you, use /critique instead.'
trigger: /design-review-framework
---

# Design Review Framework — ship gate, not pep talk

## Overview

`critique` is for the agent's own work-in-progress: five dimensions, 1–5 scale, fix anything ≤3, keep building. `design-review-framework` is the meta review the agent runs when someone hands over a finished design and asks "is this ready?" It's a structured ship gate — 6 dimensions, 0–10 scale, explicit blocker thresholds, an AI-slop signal sweep, a single go/no-go verdict at the end. Use it before launches, before stakeholder reviews, before locking a system. For day-to-day self-audit while building, use `critique` instead.

---

## Critical Constraints — read every time

1. **One verdict at the end.** `Ship`, `Ship with fixes`, or `Don't ship`. Not "looks good!" Not "lots of nice things." A clear decision the stakeholder can act on.
2. **Blocker threshold is 6.** Any dimension scoring below 6 is a blocker. Blockers must be addressed before ship — list them first, fix list second, nice-to-haves third.
3. **Score with evidence, not vibes.** Every score carries one sentence naming the specific element you scored. "Hierarchy: 5 — three elements (hero h1, secondary banner, demo CTA) compete for primary read." Not "Hierarchy: 5 — felt unclear."
4. **Run actual contrast ratios for 3 critical pairs.** Body-on-bg, primary CTA text-on-fill, muted-on-surface. Compute the numbers; don't eyeball. WCAG AA is 4.5:1 body, 3:1 large text.
5. **The AI-slop sweep is mandatory.** AI-generated work has known tells (purple gradients, stock-photo hands typing on laptops, glassmorphism cards, "Empower your workflow" copy, four-feature symmetric grids). Sweep for them; flag them.
6. **Score honestly or don't score.** If everything came back 9/10, your review is broken, not the design. Senior designers find issues. Find them.
7. **Stop at the report.** Don't apply fixes unless the stakeholder asks. The point of this skill is the decision; the fixes are downstream.

---

## The 6 dimensions (0–10 each)

### 1. Hierarchy clarity

**Question:** In three seconds, can a fresh visitor name the single most important thing on the page?

- **10** — One dominant element. Eye lands instantly. Secondary/tertiary read in order with no thought.
- **8** — Clear primary, slight ambiguity on second/third.
- **6** — Primary readable but two elements compete for attention.
- **4** — Three or more equal-weight elements. The page reads like a wall.
- **2** — Everything shouts. Eye doesn't settle.

**Scoring tip:** squint at the screen. The thing still visible when blurred is your primary. If three things stay visible, hierarchy is broken.

### 2. Visual rhythm

**Question:** Does the page have a meter — consistent section padding, consistent heading-to-body distance, consistent gutter widths?

- **10** — Section padding lands on one value (e.g. 96px desktop / 56px mobile) across every section. Heading-to-body distance lands on one value. Page reads like music.
- **7** — One section feels slightly tight or bloated relative to the others.
- **5** — Two or more rhythm breaks. The eye notices hiccups.
- **3** — Random padding. Each section feels improvised.

**Scoring tip:** measure three sections in pixels. Compare. If they differ by more than ±8px and that wasn't deliberate, deduct.

### 3. Contrast and readability

**Question:** Does every text/background pair meet WCAG AA? Are interactive elements obviously interactive without color alone?

Run the math for these three pairs (use a contrast calculator or compute relative luminance):

- Body text on `--bg`
- Primary CTA text on `--accent`
- `--muted` on `--surface`

Then score:

- **10** — All three pairs ≥4.5:1. CTAs have non-color affordance (border, underline-on-hover, icon). Semantic states (good/warn/bad) carry both color and icon/shape.
- **7** — Body and CTA pass; muted dips to ~4:1 (legible but tight).
- **5** — One pair below 4.5:1. Probably `--muted` on `--surface`.
- **3** — Body text below AA. Mandatory fix.
- **0** — CTAs invisible without hover. Site is broken for keyboard users.

### 4. Motion intent

**Question:** Does every animation earn its place — telegraphing state change, guiding attention, or signalling causality? Or is motion ornamental ("look at us, we animate")?

- **10** — Every animation has a job. Entrances explain "where this came from." Exits explain "where this went." Hovers show "this is interactive." Durations land between 140–250ms with `ease-out` on enter and slightly faster `ease-in` on exit.
- **7** — Mostly purposeful; one decorative flourish that doesn't hurt.
- **5** — Several gratuitous animations (rotating gradients, bouncing icons, full-page parallax).
- **3** — Animation distracts from content. Users would turn it off if they could.

**Scoring tip:** for each animated element, ask "what does the user learn from this motion?" If the answer is "that we know how to animate," that's slop.

### 5. Voice consistency

**Question:** Does every line of copy sound like one person wrote it, with one point of view? Or does it drift between marketing-speak, instruction-manual, and engineer-spoken?

- **10** — One voice throughout. Headlines, body, microcopy, error messages all share a register and POV. If it's "direct and builder-spoken," `404` says "this page doesn't exist" not "Oops! We can't find that page :("
- **7** — One voice in 90% of surfaces; one or two error/empty-state messages drift.
- **5** — Marketing voice in the hero, support voice in the footer, dev voice in error states. The product feels assembled from three teams.
- **3** — No consistent voice. Reads like a stock template with the placeholder names changed.

### 6. Conversion clarity

**Question:** If this artifact has a single job (capture an email, drive a signup, surface a number), is that job blindingly obvious within 5 seconds of landing?

- **10** — One primary CTA, repeated where the eye lands (top hero + mid-page after value prop + footer). Secondary actions visibly secondary. The first sentence of the page tells the visitor what they get.
- **7** — Primary CTA clear but mid-page reinforcement weak.
- **5** — Two CTAs of equal weight. User picks one — or neither.
- **3** — CTA is below the fold and visually identical to a tertiary link.
- **0** — There is no CTA, or there are five and none are primary.

**Scoring tip:** if you can't tell the artifact's single job in 5 seconds, neither can a real user. Mark it down.

---

## AI-slop signal sweep

After scoring, run this checklist. Each hit is a yellow flag — three or more is a blocker on its own, regardless of the dimension scores.

- [ ] **Purple-blue diagonal gradient** in the hero (the "AI brand" gradient).
- [ ] **Stock-photo hands typing on a laptop**, or a generic team photo, or a 3D-rendered abstract shape with no specific meaning.
- [ ] **Glassmorphism card stack** with no functional reason for the blur.
- [ ] **Four-feature symmetric grid** where the features are interchangeable adjectives (Fast / Smart / Reliable / Scalable).
- [ ] **"Empower your [workflow|team|business] with AI"** or any sentence containing "leverage," "unlock," "supercharge," "revolutionize."
- [ ] **Testimonial cards with no name, no photo, no role**, just a quote and a star rating.
- [ ] **Hero headline starting with a verb cliché** — "Transform," "Reimagine," "Discover."
- [ ] **Pricing tiers with checkmarks only**, no actual differentiation in the cell content.
- [ ] **Footer that lists 30 product features as link text** with no hierarchy.
- [ ] **Every icon is an outline icon at 24px with no variation in weight.**

Three or more checked = page reads as AI-generated regardless of polish. Flag it as a blocker.

---

## The verdict format

End every review with this exact shape. The stakeholder skims to the verdict line; everything else is supporting evidence.

```
**Verdict: Ship with fixes** (or Ship / Don't ship)

**Scores**
Hierarchy: 8 — Clear hero, but the secondary "Watch demo" button matches the primary CTA weight.
Rhythm: 7 — Features→testimonials gap is 32px tight against the 96px section meter elsewhere.
Contrast: 6 — Body 7.1:1 (good), CTA 8.4:1 (good), muted #9a9a9a on #fafafa = 3.8:1 (below AA).
Motion: 9 — Every animation purposeful; one minor bounce on icon hover is decorative.
Voice: 8 — Builder-spoken throughout except the 404 page ("Oops!" — kill it).
Conversion: 9 — Single CTA repeated three times, primary action unmistakable.

**AI-slop sweep**: 1 hit (four-feature symmetric grid with interchangeable adjectives).

**Blockers (must fix before ship)**
1. (Contrast) Darken --muted from #9a9a9a to #707070 — restores AA on supporting copy.
2. (Hierarchy) Demote "Watch demo" from filled button to text-link-with-arrow — restores single primary CTA.

**Nice-to-haves (after ship is fine)**
3. (Rhythm) Add 64px to features→testimonials gap to match section meter.
4. (Voice) Rewrite 404 page copy in the product voice.
5. (Slop) Replace the four-adjective grid with three concrete capabilities tied to user outcomes.

**Three edits the agent can apply right now**
- Token: `--muted: #707070`
- `.btn-secondary` in hero block: remove background fill, keep text + arrow only.
- 404 page: replace headline with "this page doesn't exist."
```

---

## Concrete examples

### Example A — B2B SaaS landing page

Stakeholder uploads a finished landing for a procurement tool. Ownware-design runs the framework.

```
Verdict: Ship with fixes.

Scores:
Hierarchy: 8 — Hero h1 dominant, but "Book a demo" and "Read the docs" buttons share visual weight.
Rhythm: 9 — Consistent 96px section meter throughout.
Contrast: 5 — Body 8.2:1 (good), CTA white on #2f6feb = 4.1:1 (below AA for body text on the button), muted 4.6:1 (just passes).
Motion: 10 — Only motion is a 200ms fade-in on scroll; purposeful and subtle.
Voice: 9 — Builder-direct throughout; one footer line ("We're on a mission to…") drifts.
Conversion: 8 — Primary CTA clear at top, but disappears for the middle 60% of the page.

AI-slop sweep: 0 hits.

Blockers:
1. (Contrast) Darken --accent from #2f6feb to #2456c8 — restores AA on CTA text.
2. (Hierarchy) Demote "Read the docs" to text link with arrow.

Nice-to-haves:
3. (Conversion) Add a mid-page CTA repeat after the value prop section.
4. (Voice) Rewrite "We're on a mission to…" → "We built this because procurement tools shouldn't take six weeks to roll out."
```

### Example B — Internal admin dashboard

Stakeholder uploads a finished ops dashboard. Ownware-design reviews.

```
Verdict: Don't ship.

Scores:
Hierarchy: 4 — Every panel the same size, same border, same heading weight. Eye doesn't know what's critical.
Rhythm: 6 — Grid is uniform but section padding inconsistent (16/20/24px mixed).
Contrast: 9 — Dark theme done well; all pairs pass AA.
Motion: 8 — Skeleton loaders on data fetch, no decoration.
Voice: 7 — Mostly utility voice; one button labelled "Magic ✨" breaks register.
Conversion: 5 — "Conversion" here = the operator's next action. No clear next-action affordance per panel.

AI-slop sweep: 2 hits (interchangeable icon row in sidebar, "Magic ✨" button).

Blockers:
1. (Hierarchy) Distinguish "critical-now" panels from "reference" panels — red border or top-of-grid placement.
2. (Conversion) Every panel needs a clear next-action button or it's just a number.

This is not a polish problem — it's a structural problem. Don't ship. Redesign the panel grid with a critical/reference split first.
```

---

## Anti-patterns

- **Reaching for "everything is 8 or 9 / 10."** Stop. Either you're not looking hard enough, or you're afraid of the stakeholder. Senior designers find issues — find yours.
- **Reaching for a 200-line rewrite as the fix.** Stop. If the fix is wholesale, the score was wrong (it was deeper-broken than 6) or the artifact needs a redesign, not a review. Say so out loud.
- **Reaching for "fix later, ship now" on a blocker.** Stop. Blockers don't ship. If the stakeholder pushes back on a blocker, explain the concrete user harm (e.g. "AA-failing CTA means screen readers can't tell the button is interactive — 4% of US users").
- **Reaching for the slop sweep as the whole review.** Stop. AI-slop sweep is one signal; the 6 dimensions are the score. A slop-free page can still fail hierarchy.
- **Reaching for `critique` when the user asked for a review.** Stop. `critique` is the in-build tactical version. This skill is the ship gate. Use this one when the question is "ready?"
