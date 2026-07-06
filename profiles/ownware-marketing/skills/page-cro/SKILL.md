---
name: page-cro
description: When the user wants to improve conversion on any marketing page — homepage, pricing, signup, onboarding, in-page form, popup, or paywall. Pass `surface=` to specialise the audit; the reasoning loop is the same. Also triggers on "CRO", "improve conversion", "this page isn't converting", "why isn't X working".
trigger: /page-cro
---

# Page CRO — single skill, every surface

## Overview

One CRO reasoning loop covers every page surface a marketing operator owns. The differences across `homepage / pricing / signup / onboarding / form / popup / paywall` are which dimensions matter most and what the metric is — not the framework. This skill makes the framework explicit and adapts the weight per surface.

The output is a prioritised list of changes tied to one metric, plus copy variants for the top two changes, plus a test plan for the change with the highest expected lift.

---

## Critical Constraints — read these first, every time

1. **Name the metric and the baseline up front.** No "improve conversion" — say signup rate, demo-request rate, activation %, paid-conversion %, etc., with the current number. If the user does not know the baseline, run `analytics-reader` first or label the recommendation `baseline unknown — direction only`.
2. **Surface, then audit.** The user tells you the surface (`surface=pricing` etc.) before you audit. Different surfaces weight the dimensions differently — getting it wrong wastes the recommendation.
3. **Value-of-customer evidence beats your taste.** If a recommendation depends on a claim about what the audience wants, it must trace to a source (`audience-researcher` quote, support ticket, interview). No "users probably want X."
4. **No dark patterns.** Refuse fake scarcity, confirmshame, hidden defaults, pre-checked upsells. Push back, name the pattern, offer the honest version.
5. **Recommendations carry: change, why, metric impact, effort, evidence.** Five columns. Anything missing a column is a hunch, not a recommendation.
6. **Three to seven recommendations, max.** Long lists are unactionable. The skill's job is to surface the few moves that matter.
7. **Stop at audit on first pass; do not pre-write copy.** The user picks which changes to action. THEN you call `copywriter` for the top variants.

---

## Surface weights

Use these to know which dimensions to lean on per surface. Not absolute — the page may break the pattern.

| Surface | What matters most | What matters least |
|---|---|---|
| `homepage` | Value-prop clarity, CTA hierarchy, social proof, navigation | Granular feature detail |
| `pricing` | Plan comparison clarity, anchor logic, objection handling, FAQ | Hero animation |
| `signup` | Field count, social-auth, consent copy, error states, mobile | Hero imagery |
| `onboarding` | Time-to-first-value, progressive disclosure, empty-states, encouragement | Marketing claims |
| `form` (lead capture) | Field count, trust copy near submit, consent, error handling | Visual design |
| `popup` | Timing, dismissibility, value of the offer, mobile experience | Length of copy |
| `paywall` | Why-now framing, plan choice, social proof of paid users, refund policy | Animation |

---

## Workflow

### Step 1 — Confirm scope and baseline
Ask, if not given:

- Surface (one of the seven above; or describe and we'll classify).
- Page URL or current copy.
- Primary metric to move + current value (or "unknown").
- Traffic source for this page (organic / paid / email / referral). Source changes intent.
- Constraints: brand voice, terms to avoid, things the team has tried, anything off-limits.

If `.claude/product-marketing-context.md` exists, read it before asking. Skip questions it already answers.

### Step 2 — Pull audience evidence (delegate to `audience-researcher`)
Unless the user has just done this, request VOC for this surface — what customers say about this kind of page, this kind of decision, this comparison. Two to four themes is enough.

### Step 3 — Pull baseline data (delegate to `analytics-reader`)
If the baseline isn't already known and a source is connected — pull the conversion rate, the funnel step-through, the segment breakouts (mobile vs desktop, paid vs organic, new vs returning).

### Step 4 — Audit across the five dimensions
For the surface, weight the dimensions per the surface-weights table. For each dimension, write what you see and what's missing.

1. **Value-prop clarity** — Can a fresh visitor say what this is and why they should care in 5 seconds?
2. **CTA and decision architecture** — One primary action? Visible without scrolling? Copy that communicates value, not "Submit"?
3. **Visual hierarchy and scannability** — Important elements actually prominent? Can a scanner get the main message?
4. **Trust and proof** — Logos, named testimonials, real numbers, security signals appropriate to the surface?
5. **Friction** — Field count, page weight, decision fatigue, anything that costs a conversion the page is asking for?

### Step 5 — Rank recommendations
Build the table. Use `Expected lift` ranges only where you have evidence; otherwise mark `unknown — needs test`.

### Step 6 — Stop and confirm before going further
Show the table. Ask: "Action top 2 or top 3? I'll bring `copywriter` in for variants on those."

### Step 7 — Draft variants (delegate to `copywriter`)
For each actioned change, produce 2–3 angle-labelled variants. Hand them back.

### Step 8 — Test plan for the highest-confidence change
Use `/ab-test` to structure the experiment for the top change. Include guardrail metrics.

---

## Output structure

```
# Page CRO — <surface> — <page URL> — <date>

## Brief
- Surface: <one>
- Metric: <name + baseline + source>
- Traffic source: <one>
- Constraints: <bullets>

## Audience evidence (summary from audience-researcher)
- Theme 1 — <name> — <strongest quote with source>
- ...

## Audit by dimension
### Value-prop clarity
What I see: ...
What's missing: ...

(repeat for the other four)

## Recommendations (ranked)

| # | Change | Why (metric impact) | Effort | Expected lift | Evidence |
|---|---|---|---|---|---|
| 1 | Replace hero subhead | Currently feature-led; VOC says outcome wins | Low | est. +10–20% CTR to pricing | VOC theme #1, 7 sources |
| 2 | ... |

## Variants drafted (for actioned changes only — populated after Step 6)

## Test plan (top change)
```

---

## What you never do

- Never recommend without naming a metric and (where possible) a baseline.
- Never lead with a hunch over an audience-sourced finding.
- Never propose a dark pattern, even when the user pushes for it.
- Never pre-write 7 variants of every recommendation. The user picks first.
- Never claim "industry average" or "typical lift is X%" without a real source.

---

## Worked example (abridged)

**User:** `/page-cro` — surface=pricing — `acme.com/pricing` — primary metric: paid-trial start. Baseline unknown.

**You:**
1. Call `analytics-reader` to pull last-30d /pricing → trial-start rate.
2. Call `audience-researcher` for two themes: how this category buys, what objections come up at the pricing step.
3. Audit pricing-page weights: plan comparison clarity, anchor logic, FAQ, mobile.
4. Return 5 recommendations ranked, top one being "FAQ is missing the three objections cited by 14 of the 22 reviews scanned — adding it likely lifts trial-start rate."
5. Confirm with user, then hand top 2 to `copywriter` for variants, then `/ab-test` the highest-confidence change.

That is the shape. Adapt the weights for the surface; do not change the loop.
