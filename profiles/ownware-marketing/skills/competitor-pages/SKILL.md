---
name: competitor-pages
description: When the user wants to create vs / alternative comparison pages for SEO and sales enablement — "<our tool> vs <competitor>", "best <X> alternatives", "alternatives to <competitor>". Honest about strengths AND weaknesses.
trigger: /competitor-pages
---

# Competitor / Alternative Pages — honest, sourced, useful

## Overview

You produce comparison and alternative pages that actually help the visitor decide. The category default is to ship a strawman page that exaggerates your strengths and minimises the competitor — the visitor sees through it, conversion is lower, and Google penalises thin pages. The honest version converts better and ranks better.

The deliverable is a page outline (or full draft, if the user asks) for either:

- A **`vs` page** — head-to-head with one named competitor.
- An **`alternatives` page** — your product positioned among the alternatives the visitor is comparing.

---

## Critical Constraints — read these first, every time

1. **Cite or cut.** Every comparison claim cites a source — competitor's docs, pricing page, G2 reviews, your own product. Anything uncited is removed. "We're faster" with no benchmark is filler.
2. **Acknowledge real weaknesses.** Every honest comparison admits at least one thing the competitor does better. Hiding this is the lowest-ranking pattern Google detects on these pages.
3. **No fabricated quotes.** Customer quotes are real, attributed, and have permission for use. Anonymised internal quotes are flagged.
4. **No trademark abuse.** Use competitor names accurately. Don't claim partnership / endorsement that doesn't exist. Comparative advertising is legal in most jurisdictions; misrepresentation isn't.
5. **Stay current.** Pricing, features, and positioning change. Mark the comparison data with `Last verified: <date>`. Re-verify quarterly.
6. **Audience first.** Who is comparing? An IC engineer asks different questions than a procurement director. Pick one persona per page, or split into two.
7. **VOC drives the dimensions.** The comparison dimensions come from what real users actually compare on — pulled by `audience-researcher`. Not from a feature matrix the company wishes mattered.

---

## Workflow

### Step 1 — Pick the page type and the audience
- `vs <competitor>` (one named competitor)
- `alternatives` (you placed among several)
- Audience persona — one per page.

### Step 2 — Pull VOC (delegate to `audience-researcher`)
Find quotes from real comparisons: "I switched from <competitor> because…", "I'm choosing between <A> and <B>", G2 head-to-head reviews. These tell you the dimensions that matter.

### Step 3 — Pull competitor data
Use `seo-analyst` or `web_fetch` directly:

- Competitor's current pricing page (cite the URL + date).
- Competitor's current feature list (cite the URL + date).
- Competitor's public reviews (G2 / Capterra / App Store) — find the strongest praise and the strongest critique.

Build a comparison matrix on the dimensions VOC surfaced. Be accurate.

### Step 4 — Decide the page structure
Standard `vs` page sections:

1. Hero — the honest one-line trade-off, with the buyer's question embedded.
2. Audience fit — who each tool is best for (yes, including the competitor).
3. Comparison matrix — sourced, dated, honest.
4. Real-user voice — quotes from both sides, sourced.
5. When to pick the competitor — the section that earns trust.
6. When to pick you — the section that converts.
7. Pricing comparison — be exact, link to both pricing pages.
8. FAQ — drawn from real questions in VOC.
9. CTA — start trial / book demo / see it work.

Standard `alternatives` page sections:

1. Hero — what this list is for.
2. Criteria for the list (sourced from VOC).
3. Each alternative as its own block — strengths, weaknesses, who it's for.
4. Where you fit on the list (do not put yourself first by default; rank honestly).
5. Recommendation by use case.
6. FAQ.
7. CTA.

### Step 5 — Draft (delegate to `copywriter` and `asset-author`)
Pass the comparison matrix, the VOC themes, and the structure to the helpers. `copywriter` handles the section headlines and persuasive copy; `asset-author` assembles the outline into a single artefact.

### Step 6 — Compliance + freshness signoff
- Trademark check: competitor name used accurately, no false endorsement.
- Freshness footer: `Last verified: <date>`.
- Schema markup: `Article` or `Product` review schema — `/schema-markup` separately.

---

## Output structure

```
# Competitor Page — <our tool> vs <competitor> — <date>

## Brief
- Page type: <vs | alternatives>
- Audience persona: <one>
- Primary keyword: <one>
- Goal metric: <organic clicks | trial starts | demo requests>

## VOC themes driving dimensions
- Theme 1 — <name> — <strongest sourced quote>
- ...

## Comparison matrix (sourced, last verified <date>)

| Dimension | <us> | <competitor> | Source for competitor data |
|---|---|---|---|
| Pricing entry | $X / month | $Y / month | <competitor pricing URL, 2026-05-11> |
| ... | | | |

## Page outline
<section-by-section, with headline + role + supporting content + CTA per section>

## When to pick the competitor
<sincere paragraph — what they do better>

## When to pick us
<sincere paragraph — concrete advantage>

## Freshness + compliance
- Last verified: <date>
- Trademark usage: <approved / pending>
- Schema markup queued: yes / no

## Recommended next step
- Pass outline to copywriter for headlines + section copy, then asset-author for the assembled page draft.
```

---

## What you never do

- Never claim the competitor doesn't have a feature when they do.
- Never use the competitor's name in a way that implies endorsement.
- Never put yourself first on an alternatives list without earning it.
- Never use a customer quote without permission.
- Never ship a page without a `Last verified:` date.
- Never compare on dimensions VOC didn't surface — those are vanity dimensions.

---

## Worked example (abridged)

**User:** `/competitor-pages` — vs Datadog, audience = SREs at 100+ engineer cos.

**You:**
1. Pick `vs` page; audience = SRE.
2. `audience-researcher`: themes are bill volatility, retention rules, ease of instrumentation, vendor lock-in.
3. `web_fetch` Datadog pricing + features + top G2 reviews; build comparison matrix.
4. Structure 9 sections; the "When to pick Datadog" section honestly says: deeper APM, broader integration count, more mature alerting.
5. The "When to pick us" section: predictable per-host pricing, transparent retention, faster cold-start. Each claim sourced.
6. Hand to `copywriter` and `asset-author`.
7. Mark `Last verified: 2026-05-11`. Queue `/schema-markup`.

That's the shape. The honest weakness section is the conversion driver.
