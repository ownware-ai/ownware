---
name: variance
description: Build a month-end variance commentary — actuals vs budget vs prior-period for revenue / EBITDA / cash, with line-item drivers and root cause for material variances. Use when the user asks for variance commentary, month-end close, budget variance, or "explain the variance to plan." Distinct from `/portfolio-review` (sponsor-side) — variance is corporate-finance side.
trigger: /variance
---

# Variance Commentary — Month-End Close

## Overview

The narrative that accompanies the month-end / quarter-end financial close: actuals vs budget, actuals vs prior period, with the dollar variance and the driver behind each material gap. Output is what the CFO / FP&A team distributes to leadership and the audit committee.

---

## Critical Constraints — read these first, every time

1. **Variance vs BUDGET first; vs prior period secondary.** Budget is the plan; budget variance is what leadership tracks. Prior-period is for trend context.
2. **Materiality threshold explicit.** Default: variances > 5% AND > $50K (or threshold appropriate to the company size). Below that, mention in aggregate; above, explain individually.
3. **Drivers, not just deltas.** "Revenue $5M under budget" → driver: "Customer X delayed purchase by 30 days; expected to close in M+1." Without the driver, the variance is uninterpretable.
4. **Cite the source of every number.** Trial balance, GL extract, source ticket / contract for the driver — each cited.
5. **Cross-reference to financial statement movements.** A revenue miss flows to AR change; an EBITDA miss flows to cash from operations. Make the connections explicit.
6. **No spin / no future-tense fixes in variance commentary.** "Will recover next month" — only if there's a specific transaction or contract that supports it. Otherwise: state the variance, name the cause, leave forward planning to the forecast.
7. **Reconcile to next month's forecast.** If a $5M revenue miss recurs in M+1, surface it. If it doesn't, the forecast must show that.

---

## Workflow

### Step 1 — Confirm scope
- Period (specific month or quarter)
- Entity / segment / cost center scope
- Materiality threshold (default 5%/$50K; adjust per company size)

### Step 2 — Pull data
- Actuals (trial balance / GL extract for the period)
- Budget (latest approved version, with date stamp)
- Prior period (same month last year + immediately prior period)
- Forecast (most recent rolling forecast, if applicable)

### Step 3 — Build the variance table
For revenue / cost of goods / opex categories / EBITDA / specific cash items:
- Actual ($)
- Budget ($)
- Prior period — same month last year ($)
- Variance vs budget ($, %)
- Variance vs prior YoY ($, %)
- Material? (Y/N per threshold)

### Step 4 — Drill into material variances
For each material line item:
- The driver (customer / contract / event / cost / accrual)
- The dollar amount of the driver vs the line variance (do they tie?)
- The reference (ticket, contract number, JE source)
- Continuing into next month? (Y/N + basis)

### Step 5 — Cross-reference to BS / cash
- Revenue variance → AR change → Operating cash flow impact
- COGS variance → inventory change
- Capex variance → PPE change
- EBITDA variance → operating cash flow

### Step 6 — Forecast reconciliation
If the variance recurs, where in the rolling forecast does that show up? If it doesn't, surface the disconnect.

### Step 7 — Audit committee summary
Top of document: 3-bullet plain-language summary.

### Step 8 — Generate the deliverables — `/xlsx` (variance table) and `/docx` (commentary)

Two files. The variance table lives in Excel because finance teams flex assumptions and roll the table forward; the commentary lives in Word because the audit committee reads top-to-bottom.

**Workbook via `/xlsx`** — file: `<Entity>_Variance_<Period>_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs` (period + scope + materiality threshold), `Variance_Table` (line items × actual / budget / prior YoY / $ vs budget / % vs budget / flag), `Drivers` (per material variance: driver / reference / continuing? / BS-CF tie), `Forecast_Recon` (where each recurring variance shows in the rolling forecast — or "disconnect" flagged), `Output` (audit committee summary metrics).
- Named ranges: `Materiality_Threshold_Pct`, `Materiality_Threshold_Dollars`. Flag column uses formula: `=IF(OR(ABS([@%vBudget])>=Materiality_Threshold_Pct, ABS([@$vBudget])>=Materiality_Threshold_Dollars), "MATERIAL", "")`.
- Conditional formatting on % vs Budget: red for absolute value above materiality; cross-reference cells to the Drivers sheet via comments.
- Each Actual cell carries a comment with the source (GL system + posted date or board pack reference).

**Document via `/docx`** — file: `<Entity>_Variance_Commentary_<Period>_<YYYYMMDD>.docx`.
- Cover: entity, period, version, audit-committee meeting date.
- Sections: Audit Committee Summary (3 bullets, plain language — must lead the document), Materiality Framework, Material Variance Detail (per variance: drivers + reference + continuing? + BS-CF tie), Forecast Reconciliation, Open Items / Follow-ups.
- Reference the workbook by file name in the Audit Committee Summary; the doc is the narrative, the workbook is the underlying numbers.

If either skill reports a missing-Python error, surface its install instruction and stop.

### Step 9 — Run **Final Output Checklist**

---

<correct_patterns>

### Variance table structure

```
## Variance Commentary — Period Ending 2026-04-30

### Audit Committee Summary
- **Revenue $0.8M under budget (-2.1%)**, driven primarily by a 30-day delivery slip on a Tier-1 customer; expected to close in May.
- **EBITDA $1.2M under budget (-8.3%)**, driven by the revenue shortfall plus higher S&M spending on a planned campaign that ran into May.
- **Operating cash flow $2.1M under budget**, primarily timing — customer payment terms shifted, AR up $1.8M.

### Variance Table — Revenue & EBITDA

| Line Item            | Actual ($M) | Budget ($M) | Var vs Budget ($M) | % vs Bud  | Prior Y ($M) | Var YoY ($M)  | Material |
| Revenue              | 38.4        | 39.2        | (0.8)              | -2.1%     | 35.6         | +2.8 (+7.9%)  | ⚠ Yes     |
|   Subscription       | 31.2        | 31.5        | (0.3)              | -1.0%     | 28.4         | +2.8 (+9.9%)  | No       |
|   Professional services | 7.2      | 7.7         | (0.5)              | -6.5%     | 7.2          | 0.0 (+0.0%)   | ⚠ Yes     |
| Gross Profit         | 28.5        | 29.0        | (0.5)              | -1.7%     | 26.0         | +2.5 (+9.6%)  | No       |
| Operating Expenses   | 16.8        | 16.0        | +0.8                | +5.0%     | 15.4         | +1.4 (+9.1%)  | ⚠ Yes     |
|   S&M                | 6.5         | 6.0         | +0.5                | +8.3%     | 5.8          | +0.7          | ⚠ Yes     |
|   R&D                | 5.5         | 5.4         | +0.1                | +1.9%     | 5.2          | +0.3          | No       |
|   G&A                | 4.8         | 4.6         | +0.2                | +4.3%     | 4.4          | +0.4          | No       |
| EBITDA               | 11.7        | 12.9        | (1.2)               | -8.3%     | 10.4         | +1.3 (+12.5%) | ⚠ Yes     |

Source: Trial balance period 2026-04-30, extracted 2026-05-03; budget v.2026-Q1.
```

Three reference points (actual, budget, prior YoY), with materiality flagged. Reader scans the ⚠s.

### Driver section for material variances

```
### Material Variance Drivers

#### Professional services revenue: -$0.5M / -6.5% vs budget

- **Driver:** Tier-1 customer (Customer-A) delivery slip from April → May. Final acceptance was contractually required for $0.7M of revenue recognition; testing extended into early May. PO confirmed; no commercial issue.
- **Reference:** Contract #PSO-2026-0142; Engineering ticket ENG-3492.
- **Continuing:** No. Expected May recognition $0.7M; net acceleration vs original plan.
- **Connection to BS/CF:** AR (deferred PSO accruals) up $0.7M; net working capital up; CFO down by same.

#### S&M expense: +$0.5M / +8.3% vs budget

- **Driver:** Q2 launch campaign ran into M+1 — budgeted $0.6M for April; $0.3M slipped to May. Net April spend $0.3M HIGHER than budget due to amplification ad-spend on a separate platform launch.
- **Reference:** Marketing PO #MKT-2026-0287; campaign dashboard 2026-04-30.
- **Continuing:** Partial. April-spillover campaign is one-time. The $0.3M timing reverses in May; underlying spend trajectory in line with annual plan.
- **Connection to BS/CF:** AP up $0.4M (vendor invoices not yet paid); CFO not yet impacted.
```

Each material variance: driver / reference / continuing? / BS-CF tie. The CFO has all the threads to manage.

</correct_patterns>

<common_mistakes>

### WRONG: Variance without driver

```
"Revenue down 2% vs budget."
```

Why? Driver: customer slipped, deal lost, pricing cut, market headwind, etc. Without the driver, the commentary doesn't earn its place.

### WRONG: Vague forward statement

```
"Should recover in May."
```

Based on what? Specific contract, signed PO, planned launch — name it. Otherwise the statement is wish, not commentary.

### WRONG: Threshold inconsistency

```
| Line          | Material? |
| Revenue 1%    | Yes       |   ← inconsistent with $50K threshold
| Revenue 8%    | No        |
```

Apply the threshold consistently. State it at the top.

### WRONG: Ignoring the BS / cash connection

```
"Revenue $5M short. EBITDA $4M short. Move on."
```

What about AR? Cash? Did the receivable build, or did the deal not happen at all? The CFO needs the connection.

### WRONG: No reconciliation to forecast

```
[no forward look]
```

The forecast says May/June will hit plan. Does the April variance affect that? If yes, surface the forecast adjustment. If no, state why.

### TOP 5 ERRORS

1. Variance reported without driver (uninterpretable)
2. "Should recover" / vague forward statements without specifics
3. Materiality threshold applied inconsistently
4. BS / cash connection missing
5. Forecast not reconciled (variance in M, plan unchanged for M+1?)

</common_mistakes>

---

## Quality Rubric

Every variance commentary must maximise for:

1. **Variance vs budget first** — that's the plan benchmark.
2. **Material variances drilled** — driver / reference / continuing / BS-CF tie.
3. **3-bullet audit committee summary** at the top.
4. **Materiality threshold explicit** and consistently applied.
5. **Forecast reconciliation** — does the variance flow forward?
6. **Citations** — trial balance + budget version + driver references.

---

## Final Output Checklist

- [ ] Both files generated: `<Entity>_Variance_<Period>_<YYYYMMDD>.xlsx` (table) and `<Entity>_Variance_Commentary_<Period>_<YYYYMMDD>.docx` (commentary).
- [ ] Materiality flag column on the workbook is formula-driven; commentary opens with the 3-bullet audit committee summary in plain language.
- [ ] Period and scope explicit at top.
- [ ] Audit committee summary — 3 bullets, plain-language.
- [ ] Variance table — actual / budget / prior YoY, with $ and % vs budget.
- [ ] Materiality threshold stated; flags applied consistently.
- [ ] Each material variance has a Driver section with reference + continuing? + BS-CF tie.
- [ ] Cross-reference from each material variance to BS / cash impact.
- [ ] Forecast reconciliation: does the variance flow through? Surface if yes.
- [ ] All numbers cited (trial balance period date + extraction date; budget version date).
- [ ] No vague forward statements ("should recover"); specifics required.
- [ ] No advice — narrative is reporting, not recommending.
