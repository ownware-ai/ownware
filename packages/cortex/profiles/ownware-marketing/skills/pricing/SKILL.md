---
name: pricing
description: When the user wants help with pricing decisions, packaging, or monetisation strategy. Returns a pricing exploration with willingness-to-pay evidence, tier shape, price-anchor logic, and a migration plan if existing customers are affected. Also triggers on "pricing page", "packaging", "monetisation", "raise prices", "freemium vs trial".
trigger: /pricing
---

# Pricing — willingness-to-pay first, packaging second

## Overview

You help the user reason about pricing and packaging — not just pick a number. Pricing has four layers: the unit of value, the willingness-to-pay distribution, the packaging (how tiers are shaped), and the price anchor (what the customer compares to). Get the unit wrong and every other layer is off.

This skill returns an exploration the user can use to ship a pricing change. It does not unilaterally pick the price.

---

## Critical Constraints — read these first, every time

1. **Unit of value first.** Per seat, per host, per event, per outcome, per active user — pick the metric the customer would also pick as fair. Wrong unit = constant friction.
2. **Evidence, not gut.** Willingness-to-pay signals come from real sources: closed-won deal data, surveys (Van Westendorp / Gabor-Granger), public competitor pricing, sales discount history, prospect-objection logs. Cite each.
3. **No invented anchors.** Don't claim a competitor charges $X when they charge $Y. Cite the pricing-page URL with date.
4. **Migration plan if you change prices on existing customers.** This is the single most common landmine. Always include a migration plan, even when the answer is "grandfather everyone forever."
5. **Tier complexity beyond 4 tiers loses customers.** 3 tiers is the standard for a reason. If you're past 4, justify it.
6. **No psychological pricing tricks that misrepresent value.** Charm pricing ($99 vs $100) is fine; pre-checked upsells, fake "limited-time" anchors, hidden fees are not.
7. **The pricing page is a conversion surface.** After this skill, queue `/page-cro` and `/schema-markup` for the page itself.

---

## Workflow

### Step 1 — Confirm the question
Pricing skills get asked for one of:

- Set initial pricing (new product / new tier).
- Raise prices on existing pricing.
- Re-package (move features between tiers, add / remove tiers).
- Switch monetisation model (free vs trial vs freemium; usage vs subscription).
- Audit existing pricing against signals.

Ask which one.

### Step 2 — Pick the unit of value
The metric that the customer believes scales their value with the product. Common units:

- Per-seat: SaaS where each new user gets value.
- Per-host / per-server: infrastructure.
- Per-event / per-API call: usage-driven products.
- Per-active-user: products where seats are bought but only a fraction use it.
- Per-outcome (per-deal, per-lead): performance-marketing / sales tools.
- Per-storage / per-bandwidth: data products.
- Flat / tiered: enterprise contracts.

State your recommendation with the reason. Test it against: does the metric grow with the customer's success?

### Step 3 — Pull evidence
- **Internal:** closed-won deal sizes by segment, discount rates by stage, churn reasons citing price, pricing-page conversion rate (via `analytics-reader`).
- **External:** competitor pricing pages (URL + date), reviews citing price ("expensive", "fair", "got a better deal elsewhere") via `audience-researcher`.
- **Customer survey:** if the user has Van Westendorp or Gabor-Granger data, use it; if not, recommend running one before a major pricing change.

### Step 4 — Design the tier shape
Standard shape: 3 tiers (Starter / Pro / Business), plus optional Enterprise (custom). Each tier:

- **Target customer** (size / sophistication / use case).
- **Unit metric value** (e.g. up to 5 hosts on Starter, up to 50 on Pro).
- **Feature differentiation** (what's in this tier but not the one below).
- **Anchor price.**

Resist tier-bloat. Resist feature-fragmentation.

### Step 5 — Position the anchor
Map your tiers against:

- The strongest competitor's tiers.
- The customer's stated reference point (e.g. "we currently pay $X for the alternative").

State explicitly what the anchor is for each tier — "Pro is anchored against Datadog Pro at 1/3rd the price for the same retention."

### Step 6 — Migration plan (if affecting existing customers)
- Who gets grandfathered, for how long, on which tier?
- What do they have to do to stay grandfathered (nothing / opt-in / no change)?
- How is the change communicated (email, in-app, account-manager call)?
- Refund / cancellation handling.

### Step 7 — Pricing-page implications
- Layout: comparison table, feature matrix, FAQ.
- Plan order (typically: Starter | Pro highlighted | Business | Enterprise).
- Trial / free / demo CTAs per tier.
- "Compare to <competitor>" element only if honest.
- Queue `/page-cro` for the page itself.

### Step 8 — Measurement plan
- Primary: revenue per visitor, conversion rate to paid, average contract value, expansion rate.
- Leading: pricing-page bounce, plan-mix at signup, support tickets about pricing.
- Reading: T+30, T+60, T+90.

---

## Output structure

```
# Pricing Exploration — <product> — <date>

## Question
<which of the five questions this is>

## Unit of value
- Recommended: <metric>
- Reason: <one or two lines>
- Alternatives considered and why rejected: <bullets>

## Evidence

### Internal signals
- Closed-won by segment: <data + source>
- Discount rate by stage: <data + source>
- Churn citing price: <data + source>
- Pricing-page conversion: <data + source from analytics-reader>

### External signals
- Competitor pricing (verified <date>):

| Competitor | Tier | Price | Unit | Notes |
|---|---|---|---|---|
| <A> | Starter | $29 | per user | <URL> |
| <A> | Pro | $99 | per user | <URL> |
| <B> | Standard | $0.20 | per event | <URL> |

- VOC themes around price (sourced quotes): <bullets>

### Customer research
- <Van Westendorp / Gabor-Granger results if available, or recommendation to run one>

## Tier design

| Tier | Target customer | Unit value | Differentiating features | Price | Anchor |
|---|---|---|---|---|---|
| Starter | Small teams (<10 hosts) | Up to 10 hosts | Core monitoring | $0 | Free; conversion lever |
| Pro | Mid teams (10–100 hosts) | Per-host pricing $8/host/month | Custom retention, alerts | $8/host/mo | vs Competitor A Pro at $24/host |
| Business | Larger teams | Per-host $6 + volume | SSO, audit logs, multi-region | Volume tiered | vs Competitor A Enterprise |
| Enterprise | Custom | — | SLA, dedicated CSM | Contact sales | — |

## Migration plan (existing customers)
- Who's affected: <segment>
- Treatment: <grandfather rules>
- Communication: <channels + timing>
- Cancellation / refund handling: <one line>

## Pricing-page implications
- Recommended layout: <bullets>
- Plan order: <list>
- CTAs: <list>
- FAQ topics drawn from VOC: <list>
- Queue: /page-cro, /schema-markup

## Measurement plan
- Primary KPI: <name + baseline + target>
- Leading: <list>
- Reading cadence: T+30 / T+60 / T+90.

## Risks
- <bullets — competitor reaction, customer churn, sales-cycle disruption>

## Recommended next step
- <e.g. "Run a 100-respondent Van Westendorp survey on the Pro tier; revisit anchor pricing after results land 2026-06-01.">
```

---

## What you never do

- Never recommend a tier without a target customer.
- Never claim competitor prices without a dated source.
- Never propose a pricing change without a migration plan.
- Never recommend "limited-time" pricing that isn't actually limited.
- Never pre-check upsells or hide fees.
- Never compress the tier table to look cleaner — every column is load-bearing.
- Never pick the price unilaterally. Show the math; let the user decide.

---

## Worked example (abridged)

**User:** `/pricing` — moving from per-seat to per-host pricing on an observability product. Currently $20/seat/month; want to switch.

**You:**
1. Confirm: this is a unit-of-value + repackage question.
2. Recommend per-host as the unit; reason: customers buy seats but only ops engineers log in, so growth happens via infrastructure, not seats. Source: VOC quote from G2 review citing "we paid for 30 seats and used 4".
3. Evidence: pull closed-won deals + discount history (`analytics-reader`); pull Datadog + Honeycomb pricing pages (verified date).
4. Tier shape: 3 tiers — Starter (free, up to 5 hosts), Pro ($8/host/mo), Business (volume).
5. Anchor: Pro at $8/host vs Datadog Pro at $24/host with similar retention.
6. Migration: existing customers grandfathered on seat-pricing for 12 months; opt-in tool to switch and recalculate; account-manager calls for accounts over $X.
7. Pricing-page implications: queue `/page-cro` after the new tiers are set.
8. Measurement: primary KPI = revenue per host, target = +30% over the seat baseline at T+90.

That's the shape — exploration with evidence, not a unilateral price pick.
