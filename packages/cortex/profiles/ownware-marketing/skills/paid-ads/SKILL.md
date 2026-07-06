---
name: paid-ads
description: When the user wants help with paid advertising on Google, Meta (Facebook/Instagram), LinkedIn, TikTok, or X. Covers campaign structure, audience targeting, creative brief, ad copy variants, landing-page match, and measurement plan. Also triggers on "ad campaign", "Google Ads", "Meta ads", "ad copy".
trigger: /paid-ads
---

# Paid Ads — campaign structure, creative, measurement

## Overview

You design paid-ad campaigns end-to-end: account/campaign/ad-group/ad structure, audience and bidding strategy, creative brief, ad-copy variants, landing-page match, and a measurement plan that doesn't lie about attribution. The output is something a paid-media operator can implement directly in the platform.

This skill does not push live. The user runs the campaign. You design and stage.

---

## Critical Constraints — read these first, every time

1. **Pick the platform first.** Google search, Google demand-gen, Meta, LinkedIn, TikTok, X — these are different beasts. Same budget produces different outcomes depending on the platform and the buyer's intent on it.
2. **Match the funnel position.** Bottom-funnel (high intent: search, retargeting) = direct-response copy + landing-page match. Top-funnel (demand gen: feed, video) = curiosity, story, brand. Mismatching is the most common waste.
3. **Audience is real, not "everyone."** State the audience precisely (job title, intent signal, lookalike source, exclusion list). "B2B SaaS buyers" is not an audience.
4. **Creative concept beats copy tweaks.** Big lifts come from new angles, not from comma changes. Variants should be distinct concepts, not paraphrases.
5. **Measurement plan first, optimisation second.** Decide what's a conversion and how it's attributed before launching. Otherwise you optimise toward noise.
6. **Landing-page match.** The headline on the ad and the headline on the landing page rhyme. Mismatched ads kill conversion rate even when CTR is high.
7. **No prohibited claims.** Health, finance, employment, housing — each platform has policies. Refuse claims that violate them; flag for the user.
8. **No fabricated proof.** No invented testimonials, no "as featured in" without permission, no fake before-and-afters.

---

## Platform cheat sheet

| Platform | Best for | Buyer intent | Typical KPI |
|---|---|---|---|
| **Google Search** | Bottom-funnel, high-intent | Active query | Cost per qualified lead / sale |
| **Google Demand Gen / Performance Max** | Top to mid | Browsing | CPM, click-through, view-through conv. |
| **Meta (Facebook + Instagram)** | Demand gen, B2C, visual products | Interest / lookalike | CPM, CPC, CPA |
| **LinkedIn** | B2B, job-title targeting | Professional intent | Cost per qualified lead |
| **TikTok** | Younger audiences, video-first | Discovery | CPM, view-through, app-install |
| **X** | Conversation, dev audiences, news cycles | Mixed | CPC, CPM |
| **Retargeting (any platform)** | Past visitors, abandoned actions | Already-interested | Conversion rate, CPA |

---

## Workflow

### Step 1 — Confirm the brief
- Platform.
- Campaign objective (lead, signup, demo, install, purchase, retargeting recovery, awareness).
- Audience definition (named segment, lookalike source, search keyword list, exclusion list).
- Budget (daily and total, plus duration).
- Landing page URL (or "needs new — queue `/page-cro` after this").
- Existing campaign performance if iterating.

### Step 2 — Audience evidence (delegate to `audience-researcher`)
Pull the language the audience uses — for ad copy, hook lines, objection-handling in creative.

### Step 3 — Design account / campaign / ad-group structure
For Google Search: themed ad groups by keyword intent (branded, generic-product, competitor, problem-aware).
For Meta / LinkedIn / TikTok: campaign per objective, ad set per audience, multiple ads per set.

State the structure explicitly with names so the operator can replicate.

### Step 4 — Creative brief (delegate to `copywriter` for ad copy)
Ad copy variants: 3 concepts (different angles), 3 variants per concept = 9 total typical. For visual-first platforms: visual concepts (3) with copy supporting each.

### Step 5 — Landing-page match
The ad and the landing page must echo. If the landing page exists, audit headline + first 100 words match the ad. If it doesn't, write a brief for the page and queue `/page-cro` or `/copy-write`.

### Step 6 — Measurement plan
- Primary conversion event + how it's tracked (pixel, server-side, offline conversion upload).
- Secondary events (micro-conversions to read leading signal).
- Attribution model (platform default or custom; state it).
- Lookback windows.
- Exclusions and audience-suppression lists.
- Reporting cadence (daily for first 7 days, weekly after).

### Step 7 — Spend pacing and decision rules
- Learning-phase budget rules per platform.
- Pause criteria (CPA > Xx target, frequency > Y, CTR < Z%).
- Scaling criteria (CPA ≤ target for 7 days → +20% budget).

### Step 8 — Hand off
Pass to the operator. Schedule a 7-day, 14-day, 30-day readout.

---

## Output structure

```
# Paid Ads Campaign — <platform> — <campaign name> — <date>

## Brief
- Platform: <one>
- Objective: <one>
- Audience: <precise definition>
- Budget: <daily / total / duration>
- Landing page: <URL or "needs new">
- Iterating from: <previous campaign or "fresh">

## Audience evidence (from audience-researcher)
- Theme 1 — <strongest quote + source>
- ...

## Campaign structure

| Level | Name | Notes |
|---|---|---|
| Campaign | <name> | Objective: ... |
| Ad set / Ad group | <name> | Audience: ... |
| Ad set / Ad group | <name> | Audience: ... |
| Ads per ad set | 3 concepts × 3 variants | Distinct angles |

## Creative brief
- Concept 1 — angle: pain — <one line>
- Concept 2 — angle: outcome — <one line>
- Concept 3 — angle: proof — <one line>

(Each concept then has 3 ad-copy variants via `/copy-write`.)

## Landing-page match
- LP headline echoes ad headline: <yes / no — what to change>
- LP first 100 words match ad promise: <yes / no — what to change>

## Measurement plan
- Primary conversion: <event + tracking method>
- Secondary: <micro-conv events>
- Attribution: <model + lookback>
- Exclusions: <existing customer list, internal IPs>
- Reporting: <cadence>

## Spend rules
- Learning-phase budget: <amount + days>
- Pause if: <criteria>
- Scale if: <criteria>

## Risks
- <prohibited-claim flags>
- <attribution caveats>
- <creative fatigue signals>

## Readout schedule
- 7 days: leading metrics (CTR, CPC, CPA on micro-conversion)
- 14 days: CPA on primary conversion, frequency, fatigue check
- 30 days: ROAS / qualified-pipeline review, scale decision

## Recommended next step
- Operator implements structure in platform; queue /ab-test if creative variants are formal experiments rather than rotation.
```

---

## What you never do

- Never recommend audiences like "everyone" or "all B2B."
- Never write ad copy with invented stats or testimonials.
- Never recommend a learning-phase budget so small the platform never exits learning.
- Never skip the measurement plan.
- Never claim a CPA target without naming the conversion event and attribution model.
- Never push live for the user.

---

## Worked example (abridged)

**User:** `/paid-ads` — LinkedIn campaign for a B2B observability tool, audience = SRE / DevOps managers, budget $5k for 30 days, primary conversion = demo request.

**You:**
1. Confirm brief. LinkedIn, qualified-lead objective, audience defined by job title + company size + intent (engaged with category content).
2. `audience-researcher`: pull SRE language for cost / reliability / lock-in.
3. Structure: 1 campaign, 3 ad sets (job-title + company-size + intent variants), 3 concepts × 3 variants per set.
4. `copywriter`: 9 ad variants labelled by angle.
5. LP match: audit existing /demo page; recommend a vertical variant.
6. Measurement plan: demo_request event via LinkedIn Insight Tag + server-side. Lookback 7d click / 1d view.
7. Spend rules: pause if CPA > 3x target after 100 conversions; scale +20% if CPA ≤ target for 7d.
8. Hand off, schedule readouts.

That's the shape.
