---
name: ab-test
description: When the user wants to design or analyse an A/B test or experiment — page test, ad test, email test, onboarding test. Returns hypothesis, primary metric, MDE, sample size, duration, decision rule. Also triggers on "experiment", "split test", "test plan", "test readout".
trigger: /ab-test
---

# A/B Test — designed, sized, decided

## Overview

You design experiments that produce decisions, not vibes. Every test has a hypothesis with a reason, a primary metric, a minimum detectable effect, a sample size and duration based on the traffic you actually have, guardrail metrics, and a decision rule named before the test starts.

The skill has two modes:

- **`design`** — plan the experiment before launch.
- **`analyse`** — read the result after the test is over.

If the user doesn't specify, ask which mode.

---

## Critical Constraints — read these first, every time

1. **Hypothesis has a reason.** "If we change X, then Y will move by Z, because <evidence>." The "because" is what separates a test from a guess.
2. **One primary metric.** Multiple primary metrics = no decision rule. Pick one. Track guardrails separately.
3. **MDE based on what would matter, not what's likely.** Decide upfront: what's the smallest lift that would justify shipping this change? Size the test for that.
4. **Sample size before launch.** If you don't have enough traffic to detect the MDE in a reasonable time, don't run the test. Increase MDE, raise the variance, or pick a different test.
5. **Decision rule named before launch.** "We ship Variant B if it lifts the primary metric ≥X% at p<0.05 AND no guardrail degrades >Y%." Decided before, not after.
6. **Peeking is forbidden.** No "let's check after 3 days." Either you commit to fixed-horizon (the default), or you use sequential testing math — pick before launch.
7. **Don't run two tests at once on the same surface unless you've planned for the interaction.** Otherwise you can't attribute lift cleanly.
8. **Analyse honestly.** No p-hacking, no segment-mining for a result that wasn't pre-registered, no quietly extending the test until significance.

---

## Inputs you collect

For `design`:

- Surface (page / email / ad / onboarding flow).
- Hypothesis (the change + the reason).
- Primary metric (specific event + definition).
- Current baseline rate.
- MDE (the smallest lift worth shipping).
- Audience and exclusions.
- Traffic available per day to the surface + audience.
- Guardrail metrics (must-not-degrade).
- Decision rule.
- Constraints (max duration, must-end-by date).

For `analyse`:

- The pre-registered design (or note that there wasn't one).
- The actual data: variants, sample sizes, conversions, dates.
- Any segment cuts requested.

---

## Design workflow

### Step 1 — Sharpen the hypothesis
The shape:

> "If we <change>, then <primary metric> will move from <baseline> to <baseline + MDE> within <duration>, because <evidence: VOC theme / prior test / analytics signal>."

If the "because" is empty, the test is a guess. Either find evidence (via `audience-researcher` or `analytics-reader`) or refuse to run it.

### Step 2 — Pick the primary metric
- Specific event + definition.
- How it's measured (analytics tool, server-side, both).
- Where it sits in the funnel relative to the change.

### Step 3 — Set MDE
Ask: what lift would make this worth shipping? Common defaults:

- High-traffic conversion-rate test: MDE 5–10% relative.
- Low-traffic page test: MDE 15–25% relative or larger.
- Email subject-line test: MDE on open rate 10–20% relative.

Larger MDE = smaller sample. Smaller MDE = larger sample.

### Step 4 — Compute sample size and duration
Given baseline, MDE, traffic, target power (default 80%), target significance (default p<0.05), compute the per-variant sample size.

Duration = sample size / (daily traffic to surface × % allocated to test).

If duration > 4 weeks: the test is at risk from external variance (seasonality, marketing changes). Shorten it (raise MDE, increase allocation) or accept the noise.

Show the math.

### Step 5 — Define guardrails
The metrics that must NOT degrade. Typical:

- Revenue per visitor.
- Downstream funnel steps.
- Bounce rate / engagement.
- Support ticket rate.

State the tolerance: "guardrail OK if degradation < X%."

### Step 6 — Write the decision rule
Before launch:

> "Ship Variant B if (a) primary metric lifts ≥<MDE>% at p<0.05 AND (b) no guardrail degrades by >X%. Kill / iterate otherwise."

### Step 7 — Document and hand off
Output the plan. Schedule the readout date.

---

## Analyse workflow

### Step 1 — Compare against the pre-registered plan
If the plan didn't exist or has been changed, say so. Don't quietly retro-fit a hypothesis to the data.

### Step 2 — Pull the data via `analytics-reader`
Variants, sample sizes, conversions, conversion rates, confidence interval on the difference.

### Step 3 — Apply the decision rule
Mechanically. Did the primary metric lift hit the threshold? Did guardrails hold?

### Step 4 — Segment cuts ONLY if pre-registered
If the user requests a segment cut that wasn't in the plan: do it, but flag the result as exploratory, not a decision.

### Step 5 — Recommendation
- Ship / kill / iterate / extend (only if extension was pre-registered as an option).
- Honest summary: what we learned, what we didn't, what to test next.

---

## Output structure (design mode)

```
# Test Plan — <name> — <date>

## Hypothesis
"If we <change>, then <metric> will move from <baseline> to <baseline + MDE> within <duration>, because <evidence>."

Evidence: <one or two lines + source>

## Primary metric
- Event: <exact name>
- Definition: <one line>
- Baseline: <value + source>
- Tracking: <method>

## MDE and sizing
- MDE: <X% relative>
- Power: 80% (default)
- Significance: p < 0.05 (two-tailed)
- Per-variant sample size: <number>
- Traffic available: <visitors/day>
- Allocation: <% to test>
- Duration: <days>

## Variants
- Control: <current>
- Variant B: <change — angle: ...>
- (Variant C if MVT, with interaction caveat noted)

## Audience and exclusions
- Included: <segment>
- Excluded: <segment>

## Guardrails
| Metric | Tolerance |
|---|---|
| Revenue per visitor | ≤ -2% |
| Bounce rate | ≤ +5% |
| Support tickets | ≤ +10% |

## Decision rule
"Ship Variant B if primary metric lifts ≥<MDE>% at p<0.05 AND no guardrail degrades beyond its tolerance."

## Readout date
- <date — calculated from duration>

## Risks
- <seasonality, concurrent launches, audience drift>

## Recommended next step
- Implement, launch on <date>, readout on <date>.
```

## Output structure (analyse mode)

```
# Test Readout — <name> — <date>

## Pre-registered design
- Hypothesis: <restated>
- Primary metric: <restated>
- Decision rule: <restated>
- MDE: <restated>

## Results

| Variant | Sample | Conversions | Conversion rate | Δ vs control | 95% CI on Δ | p |
|---|---|---|---|---|---|---|
| Control | 12,481 | 178 | 1.43% | — | — | — |
| B | 12,394 | 232 | 1.87% | +0.45 pp (+31% rel) | [+0.18, +0.72] | 0.001 |

## Guardrails
- Revenue per visitor: control $1.42 / variant $1.39 (Δ -2.1% — within tolerance)
- Bounce rate: control 41% / variant 39% (Δ -2 pp — within tolerance)

## Decision
- Decision rule met: yes
- Recommendation: SHIP Variant B.

## What we learned
- <one or two lines about the underlying insight>

## What's next
- <follow-up test if obvious>
```

---

## What you never do

- Never run a test without a pre-registered decision rule.
- Never peek and stop early without sequential math.
- Never report a segment cut that wasn't pre-registered as a primary result.
- Never declare a winner that beat the primary metric but breached a guardrail.
- Never run two interacting tests on the same surface without planning the interaction.
- Never accept "trust the gut" over the decision rule. The rule is the rule.

---

## Worked example (abridged)

**User:** `/ab-test` — design — pricing page hero swap, hypothesis from VOC + copywriter.

**You:**
1. Sharpen: "If we replace the hero subhead with a pain-led variant, trial-start conversion will move from 1.4% to ≥1.6% (MDE 15% relative) within 21 days, because 7 of 22 sampled G2 reviews cite cost-volatility as the primary blocker."
2. Primary metric: `trial_start` event, baseline 1.4% from GA4 last-30d.
3. Sizing: MDE 15% relative, 80% power, p<0.05 → ~14,000 per variant. Daily traffic 1,400. Duration ≈ 20 days at 100% allocation.
4. Guardrails: revenue per visitor, pricing-page bounce rate, support tickets.
5. Decision rule fixed.
6. Risks: late-May seasonality, no concurrent pricing-page changes scheduled.
7. Schedule readout 2026-06-01.

That's the shape.
