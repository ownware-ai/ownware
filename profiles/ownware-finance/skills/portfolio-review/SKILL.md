---
name: portfolio-review
description: Track a portfolio company's KPIs and variance to plan — quarterly review pack with revenue / EBITDA / cash trajectory, KPI dashboard vs target, working capital + leverage check, and red-flag list. Use when the user asks for a portfolio review, value-creation update, monthly pack, or quarterly board pack on a sponsored company.
trigger: /portfolio-review
---

# Portfolio Review — KPI Tracking + Variance to Plan

## Overview

A pack the sponsor uses to monitor a portfolio company quarter to quarter. Trends actuals vs the original investment thesis (the LBO model + value-creation plan), surfaces variance to plan with explanations, and red-flags items requiring sponsor action.

---

## Critical Constraints — read these first, every time

1. **Variance to PLAN, not just to prior quarter.** The plan is the LBO base case. Compare actuals against that, period by period. YoY and QoQ are secondary.
2. **Cite every number.** Company management reports, investor packs, board materials — each cited with date.
3. **Variance flags use a fixed scale.** `Green: +/-5% to plan` / `Yellow: 5-15% miss` / `Red: >15% miss` (or equivalent ranges by metric type).
4. **KPIs must be on the original plan.** Don't introduce new KPIs that weren't tracked at investment; that obscures whether the plan is on track.
5. **Each red flag carries a sponsor action.** "EBITDA -22% to plan" → sponsor action: "100-day intervention with portfolio ops partner; named lead by 2026-05-15."
6. **Leverage trajectory must be explicit.** Net debt / EBITDA vs covenant. Headroom matters; it's the survival line.
7. **No spin.** "On track despite headwinds" — no. State the variance; state the cause.

---

## Workflow

### Step 1 — Pull plan baseline
- LBO model (entry case): revenue, EBITDA, FCF, leverage trajectory by year
- Value-creation plan KPIs (the operational metrics the deal team committed at investment)
- Sponsor's investment thesis (3-5 bullets that justified entry)

### Step 2 — Pull actuals (delegate to `filings-explorer` if public; or work with company-provided board pack if private)
Latest period (typically last quarter): revenue, EBITDA, FCF, working capital, debt balances, KPI dashboard.

### Step 3 — Build variance table
For each headline metric:
- Plan
- Actual
- Variance ($, %)
- Variance flag (Green / Yellow / Red)
- Driver (what's behind the variance)

### Step 4 — Build KPI dashboard
For each operational KPI from the value-creation plan:
- Target (per plan)
- Latest actual
- Trajectory (last 4 quarters)
- Status (on track / at risk / off plan)

### Step 5 — Leverage and covenant section
- Pro-forma leverage at entry
- Current leverage
- Covenant threshold
- Headroom

### Step 6 — Red flags + sponsor actions
List items requiring sponsor intervention. Each: issue + impact + sponsor action + owner + deadline.

### Step 7 — Outlook (next 1-2 quarters)
- Catalysts that move the trajectory
- Risk factors
- Scenarios for the rest of the year

### Step 8 — Generate the deliverables — `/xlsx` (KPI dashboard) and `/docx` (commentary)

Two files. The dashboard lives in Excel because the operating partner flexes inputs; the commentary lives in Word because it's read top-to-bottom at the IC meeting.

**Workbook via `/xlsx`** — file: `<PortCo>_Portfolio_Review_Q<X>FY<YY>_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs` (plan baseline + period-of-record), `Plan_Actual` (the variance table), `KPI_Dashboard` (original-plan KPIs with last 4 quarters trajectory + sparklines via inline charts), `Leverage` (current / covenant / headroom), `Red_Flags` (issue / impact / action / owner / deadline), `Output` (one-line summary metrics).
- Named ranges: `Plan_Revenue_Q<X>`, `Actual_Revenue_Q<X>` (and the same per KPI). Variance columns use formulas (`=Actual - Plan`, `=Actual / Plan - 1`).
- Conditional formatting on variance %: green ≥ 0, yellow -5% to 0, red < -5%. Headroom on Leverage sheet uses the same scale.
- Each Actual cell carries a comment with the source (board pack page or management-reported field + date).

**Document via `/docx`** — file: `<PortCo>_Portfolio_Review_Q<X>FY<YY>_<YYYYMMDD>.docx`.
- Cover: PortCo name, period, version, sponsor codename (if anonymisation applies).
- Sections: Executive Summary (1 page; the verdict — on plan / off plan / acutely off), Variance Discussion (drill into each material line), KPI Commentary, Leverage + Covenant Status, Red Flags + Sponsor Actions, Outlook (next 1-2 quarters).
- Reference the workbook by file name in the Executive Summary; the doc is the narrative, the workbook is the raw deck.

If either skill reports a missing-Python error, surface its install instruction and stop.

### Step 9 — Run **Final Output Checklist**

---

<correct_patterns>

### Variance vs plan

```
### Headline Variance to Plan — Q1 FY26

| Metric              | Plan ($M) | Actual ($M) | Variance ($M / %)  | Flag    | Driver                                             |
|---------------------|-----------|-------------|---------------------|---------|-----------------------------------------------------|
| Revenue             | 95        | 92          | (3) / -3.2%         | Green   | Volume light Y/Y; pricing on plan                   |
| Adjusted EBITDA     | 28        | 22          | (6) / -21.4%        | Red     | Cost-out programme delayed (see Red Flag #1)        |
| EBITDA Margin       | 29.5%     | 23.9%       | -560bp              | Red     | Same as above                                       |
| FCF                 | 14        | 8           | (6) / -42.9%        | Red     | EBITDA + working capital build                      |
| Net debt / EBITDA   | 4.0×      | 4.6×        | +0.6×               | Yellow  | LTM EBITDA decline + WC investment                  |
| Covenant headroom   | 1.5×      | 0.9×        | -0.6×               | Yellow  | Tightening; trigger covenant test if EBITDA flat    |
```

Plan, actual, variance, flag, driver — all in one table. Reader sees what's red in 5 seconds.

### KPI dashboard vs target

```
### KPI Dashboard vs Target

| KPI                        | Q1 FY26 Target | Q1 FY26 Actual | Q4 FY25 | Q3 FY25 | Status        |
| ARR ($M)                   | 320            | 305            | 290     | 275     | At Risk       |
| New logo (count)           | 80             | 65             | 78      | 82      | At Risk       |
| Net Revenue Retention      | 118%           | 116%           | 117%    | 119%    | On Track      |
| Gross Margin               | 76%            | 75%            | 76%     | 76%     | On Track      |
| Sales productivity ($/rep) | 1.2M           | 0.95M          | 1.05M   | 1.10M   | At Risk       |
```

Targets from the plan, actuals from the latest pack, trajectory shown so reader sees direction.

### Red flag with sponsor action

```
### Red Flags + Sponsor Actions

**Red Flag #1: Cost-out programme delayed**
- **Issue:** $4M of $6M run-rate cost-out planned by Q1 FY26 not yet executed; HR consolidation slipped due to retention concerns post-deal-close.
- **Impact:** ~$5M EBITDA shortfall vs Q1 plan; if not resolved by Q3, drives full-year EBITDA -8 to -12% to plan.
- **Sponsor action:** Portfolio ops partner Bob T. assigned 2026-05-15. 100-day plan with named workstreams. Bi-weekly check-in to deal team starting 2026-05-20.
- **Owner:** CEO + Sponsor portfolio ops lead
- **Deadline for resolution:** 2026-08-15
- **Escalation:** If Q2 cost-out execution < 50% of revised plan, escalate to investment committee.
```

Each red flag: issue, impact, action, owner, deadline, escalation path. Concrete.

</correct_patterns>

<common_mistakes>

### WRONG: Variance only YoY, not vs plan

```
| Metric  | Q1 FY26  | Q1 FY25  | YoY  |
| Revenue | 92       | 88       | +5%  |
```

YoY hides whether plan is on track. The plan said $95M for Q1 FY26; actual is $92M. That's the variance that matters, not vs Y-1.

### WRONG: New KPIs introduced post-investment

```
[KPIs at investment: ARR, NRR, gross margin]
[KPIs in this review: ARR, NRR, gross margin, net new logo, AI feature attach rate, ...]
```

Adding KPIs post-investment makes the dashboard look healthier than it is (cherry-picking). Stick with the original metrics; if a new KPI is genuinely material, surface it as a flag and discuss whether to formalise.

### WRONG: "On track despite headwinds"

```
"Revenue tracking on plan despite macro headwinds and competitive intensity."
```

Spin. The numbers are the answer. If revenue is on plan, say so with the variance ($X actual vs $X plan, +/-%). If not, state the gap.

### WRONG: Red flag without sponsor action

```
**Red Flag: EBITDA -20% to plan**
[end of section]
```

What's the sponsor doing about it? Action + owner + deadline + escalation path.

### WRONG: Leverage without covenant check

```
"Leverage: 4.6×."
```

Compared to what? The covenant threshold + headroom is what matters operationally. State both.

### TOP 5 ERRORS

1. Variance only YoY, not vs plan
2. New KPIs introduced post-investment (cherry-picking)
3. "On track despite headwinds" — spin instead of variance
4. Red flags without sponsor action / owner / deadline
5. Leverage without covenant + headroom

</common_mistakes>

---

## Quality Rubric

Every portfolio review must maximise for:

1. **Variance vs plan** — the LBO base case is the benchmark.
2. **Original KPIs** — no post-hoc additions.
3. **Variance flags consistent** — Green / Yellow / Red on a fixed scale.
4. **Red flags drive action** — owner + deadline + escalation each.
5. **Leverage + covenant** — headroom explicit.
6. **No spin** — variance stated; cause stated.

---

## Final Output Checklist

- [ ] Both files generated and saved at the expected paths: `<PortCo>_Portfolio_Review_Q<X>FY<YY>_<YYYYMMDD>.xlsx` (dashboard) and `.docx` (commentary).
- [ ] Variance and headroom cells use conditional formatting (green / yellow / red); commentary references the workbook by file name.
- [ ] Plan baseline (LBO entry case + value-creation plan KPIs) at top.
- [ ] Headline variance table — plan / actual / $ + % / flag / driver.
- [ ] KPI dashboard — original-plan KPIs only, with last 4 quarters trajectory.
- [ ] Leverage section — current / covenant / headroom.
- [ ] Red flags surfaced — each with issue + impact + action + owner + deadline.
- [ ] Outlook — next 1-2 quarters with catalysts and risks.
- [ ] No new KPIs added that weren't in the original plan.
- [ ] No marketing-speak.
- [ ] All numbers cited (board pack, latest 10-Q, management report with date).
