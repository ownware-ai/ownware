---
name: financial-plan
description: Build a financial plan — cashflow scenarios, retirement projection, education / estate / cash-needs goals, asset allocation framework, sensitivity to assumptions. Use when the user asks for a financial plan, retirement projection, life-stage plan, comprehensive plan, or "the plan." The advisor signs off; the agent stages the analysis.
trigger: /financial-plan
---

# Financial Plan — Comprehensive Plan

## Overview

A structured plan that answers "given the client's goals, income, savings, and assumptions, will they be okay?" Covers cashflow, retirement, education, estate, and cash needs. Includes scenario sensitivity (what if returns are lower / inflation higher / longevity longer). The advisor signs off; this stages the analysis.

---

## Critical Constraints — read these first, every time

1. **Goals come first.** A plan without articulated goals is a spreadsheet. Goals: retirement age, lifestyle in retirement, education funding, estate intent, cash needs.
2. **Assumptions explicit and conservative-by-default.** Inflation, return, longevity, healthcare cost growth — each labelled `Assumption:` and set to a sensible default with the source. Conservative default: longer life, lower returns, higher inflation than midpoint.
3. **Cashflow scenarios — not a single point.** Bear / Base / Bull at minimum; Monte Carlo if requested.
4. **Tax-aware throughout.** Pre-tax savings (401k / IRA) vs post-tax (brokerage / Roth) vs after-tax cash needs in retirement. The numbers differ.
5. **No specific recommendations from the plan.** The advisor recommends; the plan presents scenarios. "If the client wants X, the path is Y" — not "the client should X."
6. **Sensitivity matters more than the central forecast.** A plan that works only if returns hit 8% per year and inflation stays at 2.5% is fragile. Show the breakage points.
7. **PII discipline.** Client identifier only; no full names in shared materials.

---

## Workflow

### Step 1 — Confirm goals
Articulate or extract:
- **Retirement:** target age, lifestyle (annual spending in today's dollars)
- **Education:** number of children, target funding per child, age now
- **Estate:** legacy intent, target net worth at end-of-plan
- **Cash needs:** liquidity reserve target

### Step 2 — Confirm baseline
- **Current income:** salary, bonus, equity comp, other
- **Current savings rate:** by account type (401k, IRA, brokerage, savings)
- **Current portfolio:** total + by account type + asset allocation
- **Other assets:** real estate, business, equity in private companies
- **Liabilities:** mortgage, student loans, other

### Step 3 — Set assumptions
- **Inflation:** 2.5-3.0% (conservative default 3.0%)
- **Investment returns:** by asset class — equity 6-8% real, bonds 1-2% real, cash 0% real
- **Longevity:** plan to age 90 (women) / 85 (men); use higher of couple
- **Healthcare cost growth:** 4-5% real (above general inflation)
- **Tax rates:** current marginal + retirement projected (flag if changing)
- **Social Security:** 70-80% of current benefit (modest discount for legislative risk)

Each assumption labelled and sourced.

### Step 4 — Build the cashflow projection
- Year-by-year income vs spending
- Savings additions
- Investment returns applied
- Tax payments
- Net worth trajectory

Three scenarios — Bear / Base / Bull — vary returns and inflation.

### Step 5 — Project the retirement scenario
- Year client retires
- Spending in retirement (today's dollars adjusted for inflation)
- Sources of income (Social Security, pensions, portfolio withdrawals)
- Withdrawal rate vs portfolio
- Year of plan failure (if any) under each scenario

### Step 6 — Project education funding
- Per child: target funding, current 529 / UGMA, projected need
- Funding gap and contribution required to close
- Sensitivity to college cost growth

### Step 7 — Estate / legacy
- Net worth trajectory beyond retirement
- Legacy at age 90 / 95 / 100 under each scenario
- Tax considerations (estate tax, step-up basis)

### Step 8 — Sensitivity
- Return × inflation grid (5×5)
- Longevity sensitivity (live to 90 vs 95 vs 100)
- Spending sensitivity (today's lifestyle vs +20% vs -20%)

### Step 9 — Asset allocation framework
"The plan calls for an allocation that preserves principal in down markets while delivering long-run growth." Recommend a target — but frame as plan output, not advice. Advisor signs off.

### Step 10 — Generate the deliverables — `/xlsx` (cashflow scenarios) and `/docx` (narrative)

Two files. Cashflows live in Excel because the client and advisor will flex assumptions; the narrative lives in Word because plans are read top-to-bottom in the planning meeting and signed.

**Workbook via `/xlsx`** — file: `<Client>_Financial_Plan_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs` (goals + baseline + return / inflation / longevity assumptions), `Cashflow_Conservative`, `Cashflow_Base`, `Cashflow_Optimistic` (each is a year-by-year projection: income, contributions, withdrawals, return, ending balance), `Retirement` (year-of-failure per scenario or "no failure"), `Education` (per child / school), `Sensitivity` (return × inflation, longevity × spending), `Allocation` (target allocation framework), `Output` (one-line summary per scenario).
- Named ranges: `Return_Conservative`, `Return_Base`, `Return_Optimistic`, `Inflation`, `Longevity_Years`, `Spending_Today`, `Savings_Rate`. Sensitivity tables 5×5 recompute the year-of-failure as a formula per cell.
- Conditional formatting on Retirement sheet: red on year-of-failure cells before age 90; green on "no failure" results.

**Document via `/docx`** — file: `<Client>_Financial_Plan_<YYYYMMDD>.docx`.
- Cover: client name, plan date, advisor, version. **Conservative-default disclaimer** on cover (financial-plan-class language; the advisor's compliance team usually mandates exact wording — surface to user if not provided).
- Sections: Goals & Baseline (1 page), Assumptions (sources + conservative-default basis), Three-Scenario Cashflow (narrative summary referencing the workbook), Retirement (narrative + year-of-failure interpretation), Education / Estate / Liquidity, Recommended Allocation (framed as plan output), Sensitivity Discussion, Action Items (advisor signs off).
- Heading discipline: H1 per section; tables for each scenario summary use `Light Grid Accent 1`.

**Advisor-signoff framing.** Both files are the staged pack — the advisor reviews, edits language for client-specific framing, and signs off before the planning meeting. The agent never communicates with the client directly.

If either skill reports a missing-Python error, surface its install instruction and stop.

### Step 11 — Run **Final Output Checklist**

---

<correct_patterns>

### Goals stated explicitly

```
### Goals (from intake)

- **Retirement:** Retire at age 62. Lifestyle target: $120K/year (today's dollars), inflation-adjusted thereafter.
- **Education:** Two children (ages 8 and 10). Target $300K each at 4-year private college equivalent.
- **Estate:** Leave portfolio intact at end of plan; modest legacy ~$2-3M to children.
- **Cash needs:** Maintain $100K liquidity reserve.
```

Concrete, quantified. Plan can be tested against these.

### Cashflow scenarios

```
### Net worth trajectory — three scenarios

| Year | Bear ($M) | Base ($M) | Bull ($M) |
| 2026 | 1.5       | 1.5       | 1.5       |
| 2030 | 1.9       | 2.2       | 2.5       |
| 2035 | 2.4       | 3.1       | 4.0       |
| 2040 | 3.0       | 4.5       | 6.5       |
| 2045 (retire age 62) | 3.5       | 6.0       | 9.5       |
| 2055 | 2.8       | 5.5       | 11.0      |
| 2065 (age 82) | 1.8       | 4.5       | 12.5      |
| 2075 (age 92) | 0.4       | 3.0       | 14.0      |

Bear assumptions: 4% real equity, 0% real bonds, 3.5% inflation
Base: 6% real equity, 1.5% real bonds, 2.5% inflation  ← conservative default
Bull: 8% real equity, 2.5% real bonds, 2.0% inflation

In Bear, plan supports lifestyle through age 88 then begins to draw down portfolio meaningfully.
In Base and Bull, lifestyle is sustained through end-of-plan with surplus.
```

Three scenarios with explicit assumptions. Reader sees the band.

### Sensitivity grid

```
### Sustainability — Return × Inflation grid (Probability of plan success through age 92)

Inflation ↓ \ Equity Return →   4%    5%    6%    7%    8%
                       2.0%    62%   78%   89%   94%   97%
                       2.5%    52%   68%   82%  *90%*  95%  ← Base assumption
                       3.0%    41%   58%   73%   85%   91%
                       3.5%    32%   48%   65%   78%   86%
                       4.0%    24%   38%   55%   69%   80%

Centre = base assumption (6% equity / 2.5% inflation): 90% probability of plan success.
```

Reader sees how robust the plan is to assumption errors.

</correct_patterns>

<common_mistakes>

### WRONG: No goals

```
"Plan: client has $1.5M, saves $30K/yr, retires at 65 with $X portfolio."
```

What lifestyle in retirement? Education? Estate? Without goals, the plan can't be tested.

### WRONG: Single-scenario plan

```
"Net worth at retirement: $6M. Plan succeeds."
```

Plans built on single forecasts are fragile. Show Bear / Base / Bull and breakage points.

### WRONG: Aggressive returns

```
"Equity returns: 9% real."
```

Long-run real US equity returns are ~6-7%. Above-historical assumptions inflate the plan. Conservative default: 6% real equity, 1-2% real bonds.

### WRONG: Specific recommendations

```
"The client should max out 401k contributions and convert $50K to Roth this year."
```

The advisor recommends; the plan presents. Replace with: "If the client wants to maximise tax-deferred space, the actions are: 401k contribution increase to $X, Roth conversion of $Y. Sensitivity in Section 5."

### WRONG: Inflation ignored

```
[uses today's dollars throughout, no inflation adjustment]
```

A 30-year plan with no inflation is wrong. Healthcare grows above general inflation. College grows above general inflation. Adjust.

### TOP 5 ERRORS

1. No goals (plan can't be tested)
2. Single-scenario forecast (plan looks more robust than it is)
3. Aggressive return assumptions (above-historical)
4. Specific recommendations from the plan (advisor's role)
5. Inflation ignored or under-adjusted

</common_mistakes>

---

## Quality Rubric

Every financial plan must maximise for:

1. **Goals quantified** — retirement age, lifestyle, education, estate, liquidity.
2. **Conservative-by-default assumptions** — labeled, sourced, conservative.
3. **Three-scenario projection** — Bear / Base / Bull.
4. **Tax-aware throughout** — pre-tax / post-tax / Roth distinguished.
5. **Sensitivity grid** — return × inflation, longevity, spending.
6. **No specific recommendations** — plan presents scenarios; advisor decides.

---

## Final Output Checklist

- [ ] Both files generated: `<Client>_Financial_Plan_<YYYYMMDD>.xlsx` (cashflow scenarios) and `.docx` (narrative).
- [ ] Year-of-failure cells in Retirement sheet use conditional formatting; sensitivity tables 5×5 are full per-cell recalcs.
- [ ] Goals section quantifies retirement age, lifestyle, education, estate, liquidity.
- [ ] Baseline section captures current income, savings rate, portfolio, liabilities.
- [ ] Assumptions block — each labelled with source and conservative-default basis.
- [ ] Three-scenario cashflow projection.
- [ ] Retirement projection with year-of-failure under each scenario (or "no failure" if plan holds).
- [ ] Education funding projection per child with funding gap.
- [ ] Estate / legacy at end-of-plan under each scenario.
- [ ] Sensitivity grid — return × inflation, with success probability.
- [ ] Asset allocation framework — plan output, advisor signs off.
- [ ] No specific advice / recommendations from the plan.
- [ ] PII discipline — client identifier, not full name.
