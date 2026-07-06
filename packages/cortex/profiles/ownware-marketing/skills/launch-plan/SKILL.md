---
name: launch-plan
description: When the user wants to plan a product or feature launch — positioning, channels, assets, calendar, measurement. Returns a structured launch plan via asset-author. Also triggers on "launch this", "release announcement", "go-to-market plan", "feature announcement".
trigger: /launch-plan
---

# Launch Plan — positioned, scheduled, measured

## Overview

You produce a launch plan that turns a product or feature ship into a coordinated set of channel actions with assets, owners, dates, and measurement. The output is a single artefact — short enough to be a working doc, complete enough to drive execution.

The skill orchestrates: positioning (you + the user), VOC (audience-researcher), asset list (copywriter for the headlines, asset-author to assemble), and a measurement plan that reads honestly.

---

## Critical Constraints — read these first, every time

1. **Positioning is the spine.** Without a sharp positioning paragraph, every downstream asset wobbles. State it first; iterate it before writing channel briefs.
2. **Who, what, why-now, what's different — answered in one paragraph.** If you can't, the launch isn't ready.
3. **Channels match audience, not vanity.** Pick channels the audience actually uses. A LinkedIn post for a B2C consumer launch is a waste; a TikTok video for a CFO product is a waste.
4. **Every asset has an owner and a due date.** "Marketing handles the launch page" is not a plan. "Sarah ships the launch page by 2026-05-29" is.
5. **Source the proof.** Customer quotes, beta numbers, partner logos — all real, all sourced, all signed off.
6. **Pre-launch beats day-of.** The most leverage is in pre-launch (warming the audience, briefing partners, lining up coverage). Day-of is execution; the plan is built weeks ahead.
7. **Measurement plan distinguishes launch from baseline.** Marketing always sees a launch spike; the question is whether the lift is durable. Plan for the 7-day, 30-day, 90-day reads.
8. **Roll-back plan if it breaks.** If the product launch reveals a bug, who pauses what?

---

## Workflow

### Step 1 — Capture the brief
Ask:

- What's shipping? (Product, feature, repositioning, integration, pricing change.)
- Why now? (Customer demand, competitive move, internal milestone.)
- Who is the audience — segment-specific, not "everyone."
- What's different? (Versus the previous version, versus competitors, versus alternatives.)
- Constraints: must-launch-by date, must-not-go-public-until, regulatory or partner approvals.

### Step 2 — Draft positioning
A one-paragraph positioning statement:

> For <audience>, <product / feature> is the <category> that <key benefit + mechanism>, unlike <alternative> which <limitation>. Available <when>.

Refine with the user. This drives every asset.

### Step 3 — Audience evidence (delegate to `audience-researcher`)
What does the audience already believe about this category? What's the strongest language for the value? What objections come up?

### Step 4 — Decide waves
For a non-trivial launch, plan in waves:

- **Wave 0 — internal & alpha (T-N weeks):** team alignment, FAQ, support training, alpha customers.
- **Wave 1 — beta / partner (T-2 to T-4 weeks):** named beta customers, partner co-marketing, analyst briefings.
- **Wave 2 — public launch (T0):** general public, press, social, ads.
- **Wave 3 — post-launch (T+1 to T+12 weeks):** sustained content, conversion optimisation, case studies from launch customers.

### Step 5 — Channel and asset map
For each wave, list channels and the assets needed per channel. Owner and due date per asset.

### Step 6 — Calendar
Build the calendar (Mermaid Gantt or table). Confirm critical dependencies (legal review must precede external send).

### Step 7 — Measurement plan
- Primary launch KPI (signups, demo requests, opt-in, revenue, NPS — pick one).
- Leading indicators (page traffic, share of voice, ad engagement).
- Reading cadence: T+1, T+7, T+30, T+90.
- Definition of "durable lift" — what does the 30-day cut have to look like for the launch to count as a win?

### Step 8 — Risks and rollback
- What could go wrong (PR, technical, regulatory, positioning).
- For each: mitigation + rollback action.

### Step 9 — Assemble (delegate to `asset-author`)
Hand the full structure to `asset-author` for the launch-plan artefact. Default save path: `./launches/<launch-name>.md`.

---

## Output structure

```
# Launch Plan — <product / feature> — Target launch <date>

## Positioning
For <audience>, <product> is the <category> that <benefit + mechanism>, unlike <alternative> which <limitation>. Available <when>.

## Audience evidence (from audience-researcher)
- Theme 1 — <sourced quote>
- ...

## Waves

### Wave 0 — Internal + alpha (<date range>)
- Internal FAQ — owner Sarah — due 2026-05-15
- Support training — owner Kai — due 2026-05-18
- Alpha customer briefing — owner Sales — due 2026-05-20

### Wave 1 — Beta / partner (<date range>)
- Beta customer case studies (3) — owner Marketing — due 2026-05-25
- Partner co-marketing brief — owner BD — due 2026-05-27
- Analyst briefings (3 scheduled) — owner PR — due 2026-05-28

### Wave 2 — Public launch (<date>)
- Launch page (/launch-X) — owner Sarah, copy by /copy-write — due 2026-05-29
- Launch blog post — owner Marketing — due 2026-05-29
- Email blast to existing list — owner Lifecycle — due 2026-05-30 09:00 ET
- LinkedIn + X posts (via /social-content) — owner Marketing — due 2026-05-30 09:00 ET
- Paid ad campaign (via /paid-ads) — owner Performance — live 2026-05-30
- Press release — owner PR — embargo 2026-05-30 09:00 ET

### Wave 3 — Post-launch (T+1 to T+12 weeks)
- Day-after recap email — owner Lifecycle — due 2026-05-31
- Case study write-ups (3 alpha customers) — owner Marketing — due 2026-06-13
- CRO pass on /launch-X page — via /page-cro — due 2026-06-06
- Sustained content cadence (1 post / week) — owner Content

## Calendar (Mermaid Gantt)
\`\`\`mermaid
gantt
  title Launch Calendar
  dateFormat YYYY-MM-DD
  section Wave 0
  Internal FAQ        :2026-05-12, 4d
  Support training    :2026-05-14, 5d
  section Wave 1
  Beta case studies   :2026-05-18, 8d
  Partner brief       :2026-05-22, 6d
  section Wave 2
  Launch page         :2026-05-25, 5d
  Email blast         :2026-05-30, 1d
  section Wave 3
  Case studies        :2026-05-31, 14d
\`\`\`

## Measurement plan
- Primary KPI: <one + baseline + target>
- Leading indicators: <list with current values>
- Reading cadence:
  - T+1: launch-page traffic, sign-ups, channel mix
  - T+7: conversion rate, qualified leads, ad-channel CPA, share-of-voice
  - T+30: durable lift on primary KPI, retention of launch-cohort signups
  - T+90: case-study readiness, sustained channel performance

## Definition of a winning launch
- <durable-lift threshold on the primary KPI>
- <one or two qualitative wins: e.g. signed beta partners, named analyst coverage>

## Risks
| Risk | Mitigation | Rollback |
|---|---|---|
| Product bug surfaces post-launch | QA gate Wave 1; on-call eng during Wave 2 | Pull launch page + send corrective email |
| Coverage slips | Confirm embargo + brief 5+ outlets | Push date or accept smaller coverage |
| Pricing pushback | Have FAQ + sales talk-track ready | Same-day FAQ + blog response |

## Open questions
- <bullets>

## Recommended next step
- Save plan to `./launches/<name>.md` via asset-author. Confirm owners and dates with each named person.
```

---

## What you never do

- Never produce a launch plan without a sharp positioning paragraph.
- Never list owners as "Marketing" — name a person.
- Never put fabricated case studies, partner logos, or analyst quotes into the plan.
- Never plan everything for day-of; pre-launch is where the leverage is.
- Never skip the rollback plan, even when the launch feels low-risk.

---

## Worked example (abridged)

**User:** `/launch-plan` — launching a new "per-host pricing" tier for the observability product, target date in 3 weeks.

**You:**
1. Capture brief, draft positioning, confirm with user.
2. `audience-researcher`: pull pricing language from VOC — "predictable bill", "no surprise invoices."
3. Waves: alpha (internal + 5 named customers) → beta (partner + analyst) → public (T0) → post-launch.
4. Channel map: launch page, blog, email to existing list, LinkedIn + X, paid LinkedIn campaign, 3 case studies.
5. Calendar in Mermaid Gantt.
6. Measurement: primary KPI = trials started on the new tier; durable lift = ≥40% of new trials choose the new tier 30 days post-launch.
7. Risks: pricing pushback, coverage slip, billing-system bugs.
8. Assemble via `asset-author`; save to `./launches/per-host-pricing.md`.

That's the shape.
