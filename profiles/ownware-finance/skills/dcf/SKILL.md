---
name: dcf
description: Build an institutional-quality discounted-cash-flow valuation with comps-informed terminal multiples, Bear/Base/Bull cases, and sensitivity analysis. Use when the user asks for a DCF, intrinsic value, fair-value estimate, or "what's it worth" on a public company; or when a pitchbook / IC memo needs the DCF leg of a football field.
trigger: /dcf
---

# DCF — Discounted Cash Flow

## Overview

A DCF that actually flexes. Every assumption is labelled. Every cell traceable. The output is a Bear/Base/Bull-aware model with three sensitivity tables at the bottom, the implied price compared to spot, and a sanity check on terminal-value share of EV. The user reads this and forms their own view — you do not tell them what to do with it.

---

## Critical Constraints — read these first, every time

These hold regardless of company, sector, or sponsor type. Re-read before starting; re-check before delivering.

1. **Inputs come cited or they don't come in.** Every historical figure, market-data point, and consensus reference traces to a source. If `filings-explorer` hasn't pulled it, **stop and ask** — do not estimate.
2. **Terminal growth < WACC.** Strict inequality. If `g ≥ WACC` your formula prints infinity and the model is broken.
3. **Operating expenses scale on revenue, not gross profit.** Hard rule. `S&M = Revenue × X%`, never `Gross Profit × X%`.
4. **Working capital changes off ΔRevenue, not Revenue.** `ΔNWC = (Revenue_t - Revenue_{t-1}) × NWC%`.
5. **Mid-year discount convention.** Periods are 0.5, 1.5, 2.5, …, (N − 0.5) for the explicit window; terminal value discounted at (N − 0.5) too. Flag if switching to end-of-year.
6. **Diluted shares, not basic.** Includes options + RSUs + convertibles.
7. **Net debt sign matters.** Cash > Debt → net cash → ADDED to EV (not subtracted). Surface it explicitly.
8. **Sensitivity tables are odd-dimensioned.** 5×5 standard. Centre row = base WACC; centre column = base terminal g. Centre cell highlighted; its value MUST equal the base-case implied price (sanity check that the table is built correctly).
9. **Verify with the user at four checkpoints — do not race to a final number.** Inputs → Assumptions → FCF build → Sensitivity. After each, present, confirm, advance.
10. **Cite-as-you-build.** Every hardcoded input gets `Source: <doc> <date> <section>` annotated at the time it's introduced. Don't defer to the end.

---

## Workflow

### Step 1 — Confirm scope
Acknowledge the target (ticker / name) and any user-provided framing (situation, comp set preference, projection horizon, special cases). Default horizon: **5 years**, **7-10** for high-growth, **3** for mature/stable.

### Step 2 — Pull historicals (delegate to `filings-explorer`)
Required inputs (fail loudly if any missing):
- Revenue (last 3 FY actuals + LTM if available)
- Gross / EBIT / EBITDA margins (last 3 FY)
- Effective tax rate (last 3 FY)
- D&A as % of revenue (last 3 FY)
- CapEx as % of revenue (last 3 FY)
- ΔNWC / ΔRevenue (last 3 FY)
- Diluted shares outstanding
- Total debt and cash & equivalents (latest BS)
- Current stock price

**Stop and confirm with the user** that the historicals look right before projecting. A wrong margin assumption discovered after sensitivity tables means rebuilding everything downstream.

### Step 3 — Set assumptions (Bear / Base / Bull)
For each scenario, project across the explicit horizon:

| Driver | Bear | Base | Bull |
|---|---|---|---|
| Revenue growth (%) | conservative (low end of historical) | consensus / management guide | optimistic |
| EBIT margin (%) | flat or compressing | moderate expansion via opex leverage | significant expansion |
| Tax rate (%) | higher | base 21–28% | structurally lower |
| D&A % of revenue | history average | history average | declining slightly |
| CapEx % of revenue | history + 1pt (ageing fleet) | history average | structurally lower |
| NWC % of ΔRev | history + 100bp | history average | history − 100bp |
| Terminal growth (%) | 2.0–2.5 | 2.5–3.0 (long-run nominal GDP) | 3.5–5.0 (only for true market leaders) |
| WACC adjustment | + 100bp risk premium | base | − 100bp |

**Stop and confirm with the user** that the cases bracket plausible outcomes. The Base must be your honest best estimate, not an arithmetic mean of Bear and Bull.

### Step 4 — Pull market data for WACC
- Risk-free rate: 10Y UST yield via `[FRED DGS10, latest release]`
- Beta: 5-year monthly vs S&P 500. **Source:** FactSet / Bloomberg if configured; otherwise flag as "not available without paid feed" and ask the user to provide.
- Equity risk premium: 5.0–6.0% market standard (cite the convention you're using — Damodaran annual update is the conventional reference)
- Pre-tax cost of debt: from credit rating, or interest expense / total debt from financials; flag the method used
- Capital weights: market value (current price × shares + net debt), not book

### Step 5 — Build FCF (delegate to `valuation-builder`)
Hand `valuation-builder` the inputs + assumptions block. It returns the FCF schedule with every formula traceable. The standard build:

```
EBIT
(–) Taxes (EBIT × tax rate)
= NOPAT
(+) D&A (% of revenue)
(–) CapEx (% of revenue)
(–) ΔNWC (% of ΔRevenue)
= Unlevered FCF
```

**Stop and confirm with the user** that the FCF trajectory looks right (growth tapering toward terminal, margins on plan).

### Step 6 — WACC
```
Cost of Equity = Risk-Free + Beta × ERP
After-tax Cost of Debt = Pre-tax × (1 − Tax)
WACC = E/(E+D) × Re + D/(E+D) × Rd_after_tax
```

If net cash position: D is negative, debt weight may be negative — model accordingly.

### Step 7 — Discount + terminal value
- Discount each year's FCF using mid-year periods.
- Terminal value via perpetuity growth: `TV = FCF_N × (1 + g) / (WACC − g)`. Cross-check via exit multiple: `TV_alt = EBITDA_N × peer-median EV/EBITDA`. Flag if they're more than 25% apart.
- PV(Terminal) = TV / (1 + WACC)^(N − 0.5).

### Step 8 — Equity bridge
```
EV = Sum(PV of explicit FCFs) + PV(Terminal)
Equity Value = EV − Net Debt   (or + Net Cash)
÷ Diluted Shares
= Implied Price
```
Compare to current price; report implied upside/downside as a percentage.

### Step 9 — Sensitivity (three tables, all 5×5)
1. **WACC × Terminal growth** — primary
2. **Revenue CAGR × Terminal EBIT margin** — operational levers
3. **Beta × Risk-Free rate** — cost-of-equity components

Each table 5×5. Centre = base case, highlighted. **Every cell recalculates the full DCF for that combination** — no linear approximations.

### Step 10 — Cross-check
- DCF-implied EV/EBITDA vs peer median (call `/comps` if not already done) — within 25%? If not, surface why.
- DCF-implied P/E vs peer median.
- Terminal value as % of EV (target 50–70%; flag if outside).
- Implied revenue CAGR embedded in the price vs peer growth rates.

### Step 11 — Generate the workbook via `/xlsx`

Hand off to the `/xlsx` skill with the model graph above. Specify:

- File: `<Ticker>_DCF_<YYYYMMDD>.xlsx`, saved to the user's working directory unless the user gave a path.
- Sheets (canonical order): `Inputs`, `Assumptions`, `Model`, `Sensitivity`, `Output`.
- Named ranges (must exist as `DefinedName` entries): `WACC`, `Terminal_Growth`, `Tax_Rate`, `Beta`, `ERP`, `Risk_Free`, `Net_Cash`, `Diluted_Shares`, plus per-year drivers (`Revenue_Growth_Y1` … `Revenue_Growth_YN`, `EBIT_Margin_Y1` …).
- Formulas live everywhere; no hardcoded computed values. Every flexable input is a named range; every formula references the name, not a coordinate.
- Each hardcoded input gets a cell comment with its source citation (the ones you accumulated through Steps 2-4).
- Three sensitivity tables, all 5×5: WACC × Terminal Growth (primary), Revenue CAGR × Terminal EBIT Margin, Beta × Risk-Free. Centre cell highlighted; centre cell formula must equal the base-case implied price.

If `/xlsx` reports a missing-Python error, surface its install instruction and stop. Do not fall back to an ASCII-table "workbook" in chat — the deliverable is the `.xlsx` or it is nothing.

### Step 12 — Verify before delivering
Run the **Final Output Checklist** (below). Fix any breach before sending.

---

<correct_patterns>

### Showing every formula

```
Revenue FY25E = $383.3B × (1 + 8.5%) = $415.9B
[Apple 10-K FY2024, p. 32 for FY24 actual; Assumption: Base case revenue growth Y1]

EBIT FY25E = $415.9B × 30.5% = $126.8B
[Apple 10-K FY2024, p. 32 for FY24 EBIT margin baseline; Assumption: 50bps expansion]

NOPAT FY25E = $126.8B × (1 − 23.0%) = $97.6B
[Apple 10-K FY2024, p. 35 for FY24 effective tax rate]
```

Every line carries the formula AND the cited source for every input.

### Sensitivity table — centre cell highlighted

```
Implied Price ($), 5×5: WACC × Terminal Growth

WACC ↓ \ g →    2.0%   2.5%   3.0%    3.5%   4.0%
       8.0%    $215   $235   $260    $295   $345
       8.5%    $195   $210   $230    $260   $300
       9.0%    $175   $190  *$208*   $230   $260   ← centre row = base WACC
       9.5%    $160   $172   $187    $205   $230
      10.0%    $148   $158   $170    $185   $205
                              ↑
                     centre column = base terminal g
```

The starred cell value (`$208`) MUST equal the model's base-case implied price. If it doesn't, the table's formulas are wrong.

### Equity bridge with net cash position

```
EV                 = $1,850B
(+) Net Cash       = $40B    ← Apple is net cash; ADD to EV
Equity Value       = $1,890B
÷ Diluted Shares   = 15.2B
Implied Price      = $124.34
[Apple 10-Q Q4 FY24, p. 4 for cash + debt + shares]
```

The sign-flip on net cash is explicit, with a reader-facing comment.

</correct_patterns>

<common_mistakes>

### WRONG: OpEx based on gross profit

```
S&M = Gross Profit × 15%   ← WRONG: scales with margin, not volume
```

Correct:
```
S&M = Revenue × 15%
```

OpEx scales on revenue. Using gross profit produces unrealistic margin progression as a side effect of margin assumptions, double-counting the leverage.

### WRONG: Terminal growth ≥ WACC

```
WACC = 8.5%, terminal g = 9.0%   ← TV formula prints infinity
```

Strict inequality. If `g ≥ WACC` the model is broken — flag and ask the user to revisit assumptions before proceeding.

### WRONG: Linear approximations in sensitivity

```
B97 = B88 × (1 + (0.096 − 0.116))   ← Adjusting one cell linearly
```

This is not a recalculated DCF; it's a back-of-the-envelope adjustment. Sensitivity cells must each contain a full DCF recalculation.

### WRONG: Stripping citations during transcription

```
Revenue FY24: $383.3B   ← no source line
Net debt: $40B (net cash)   ← no source line
```

Every hardcoded input carries `[<source>, p. N]` on the next line. Don't defer to a "Sources" section at the bottom — the citation lives next to the number.

### WRONG: TV % EV outside the band, ignored

```
PV(Terminal) = $850B → 92% of EV
(model delivered without commentary)
```

When TV is > 75% of EV, the analysis is over-reliant on terminal assumptions. Flag in `Notes`. Same below 40% (terminal too conservative or explicit period too long).

### TOP 5 ERRORS

1. OpEx scaled on gross profit instead of revenue
2. Terminal growth ≥ WACC (formula breaks)
3. Sensitivity built with linear approximations instead of full DCF recalc
4. Citations stripped on hardcoded inputs
5. Net cash position not flagged in the equity bridge

</common_mistakes>

---

## Quality Rubric

Every DCF must maximise for:

1. **Realistic revenue and margin assumptions** anchored to historical performance and peer benchmarks.
2. **Defensible cost of capital** with proper CAPM and explicit weights.
3. **Comprehensive sensitivity** — three tables, all 5×5, centred on base case.
4. **Transparent terminal value** with both perpetuity-growth and exit-multiple cross-checks.
5. **Clean equity bridge** — net debt sign explicit, diluted shares used.
6. **Cross-check vs peers** — DCF-implied multiples reconciled to peer median or differential explained.

---

## Final Output Checklist

Before delivering, every item must be true:

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Ticker>_DCF_<YYYYMMDD>.xlsx`.
- [ ] Workbook has named ranges for `WACC`, `Terminal_Growth`, `Tax_Rate` at minimum; flexing any of them ripples through the Model and Sensitivity sheets.
- [ ] Every hardcoded input has `[<source>, p. N]` on the next line.
- [ ] All four user-confirmation gates were respected (inputs → assumptions → FCF → sensitivity).
- [ ] Bear, Base, Bull cases each fully populated; Base is the honest best estimate.
- [ ] Terminal growth strictly < WACC.
- [ ] OpEx scales on revenue, not gross profit.
- [ ] ΔNWC scales on ΔRevenue, not Revenue.
- [ ] Mid-year discount convention applied (or end-of-year flagged).
- [ ] Diluted shares used in equity bridge; net debt sign correct.
- [ ] Three sensitivity tables, all 5×5, centre cell highlighted, centre cell value = base case implied price.
- [ ] TV as % of EV in 50–70% band, or breach flagged in `Notes`.
- [ ] DCF-implied EV/EBITDA cross-checked against peer median (call `/comps` if not already done).
- [ ] No investment advice. Implied price stated; the user decides.
