---
name: lbo
description: Build a leveraged buyout model — sources & uses, debt schedule with mandatory and sweep amortisation, EBITDA-based exit, IRR / MOIC / cash-on-cash sensitivity. Use when the user asks for an LBO, sponsor model, leveraged returns analysis, or wants to test whether a buyout works at a given entry leverage. Also the underpinning of the LBO leg in a pitchbook football field.
trigger: /lbo
---

# LBO — Leveraged Buyout Model

## Overview

A sponsor-perspective LBO that prices the target at entry, layers in debt across tranches, runs operating projections with cash sweep against the highest-priority debt, exits at a multiple, and reports IRR, MOIC, and cash-on-cash with sensitivity. The output tells the user what return the deal needs to clear and where the value is created (multiple expansion vs deleveraging vs operating improvement).

---

## Critical Constraints — read these first, every time

1. **Sources = Uses, exactly.** Every dollar of consideration is funded; every dollar of funding is allocated. If they don't tie, the model is broken.
2. **Debt schedule waterfall is strict.** Mandatory amortisation first; cash sweep applied to the highest-seniority remaining debt; revolver is the elastic, drawn only when cash is insufficient.
3. **Cash sweep is optional, not assumed.** Don't sweep 100% of free cash by default — that ignores minimum cash needs. Default sweep: 75% of free cash above a $50–100mm minimum cash balance. Confirm with the user.
4. **Entry leverage cited to peer set, not rule of thumb.** "Sponsor-friendly assets trade at 5.5–6.5× LTM EBITDA at entry — for this target the peer set supports X.X×" with the comparable group named.
5. **EBITDA addbacks separately disclosed.** Pro-forma adjustments (synergies, run-rate cost-outs, owner compensation, one-timers) are line items, not blended into EBITDA. Reader must see what's reported vs what's adjusted.
6. **No double-counting deal expenses.** Transaction fees, financing fees, and OID are uses on Day 1. Don't also add them to operating expenses going forward.
7. **Tax shield from interest is real.** `Interest × marginal tax rate` flows into reduced cash taxes — don't ignore it.
8. **Revolver assumed undrawn at entry** unless the user says otherwise. Some assets need working-capital facilities at close; ask.
9. **Verify with the user at four checkpoints** — Sources & Uses → Operating projections → Debt schedule → Exit & returns — before completing.

---

## Workflow

### Step 1 — Confirm the deal
- Target (ticker / private company name)
- Entry: take-private of public co, sponsor-to-sponsor, carve-out, founder buyout, etc.
- Sponsor side (or generic if not specified)
- Holding period (typically 5 years)
- Entry premium (if take-private — usually 25–40% to unaffected price)

**Stop and confirm** the deal contour with the user.

### Step 2 — Pull operating profile (delegate to `filings-explorer` and/or `market-researcher`)
- LTM and 3Y revenue, EBITDA, EBITDA margin
- Working capital intensity
- CapEx (maintenance vs growth)
- Existing debt at close (refinanced or assumed)
- Tax rate (US federal + state blended)
- Pension / lease / off-BS obligations

### Step 3 — Build Sources & Uses
**Uses** (Day 1):
| Item | Amount | Notes |
|---|---|---|
| Equity purchase price | (Premium × pre-deal mkt cap) for take-private | offer per share × diluted shares |
| Refinance existing debt | + face value of debt rolled | (or assumed) |
| Transaction fees (M&A advisor + lawyers) | + 1.5–2.0% of EV | one-time |
| Financing fees | + 2.5–3.5% of new debt issued | OID / commitment / arrangement |
| Working capital infusion (if needed) | + as required | rare |
| **Total Uses** | $X | |

**Sources** (Day 1):
| Item | Amount | Notes |
|---|---|---|
| Senior Secured Term Loan B | $X | typically L + 350–450bp |
| Senior Notes (or 2L) | $X | fixed-rate, often bullet |
| Mezzanine / Sub Notes (if used) | $X | higher coupon, sometimes PIK |
| Revolver (undrawn at close) | $0 | available capacity |
| Sponsor equity | (plug) $X | the residual |
| **Total Sources** | $X (= Total Uses) | |

**Stop and confirm** the capital structure with the user. Compute `Total Debt / LTM EBITDA` and compare to peer-set leverage.

### Step 4 — Project operations
Standalone case: revenue growth, margin expansion (operating improvement), capex intensity, working capital. Use the `/3sm` foundation if a full integrated model is needed.

Sponsor improvements (often modeled separately and called out):
- Cost-out programmes (year 1–2; cited as run-rate)
- Pricing actions (year 1–3)
- Volume initiatives (year 1–3)
- Working-capital optimisation (DPO extension, AR acceleration)

**Surface every sponsor improvement as an explicit row**, not embedded in the base operating projection.

### Step 5 — Build the debt schedule
For each tranche, project:
- Opening balance
- Mandatory amortisation (per credit agreement)
- Cash sweep (if any free cash above the min-cash threshold, after mandatory)
- Closing balance
- Average balance (for interest calc)
- Interest expense (= average balance × rate)
- PIK accrual (if any)

Sweep waterfall (default): TLB → 2L Notes → Mezz → unsecured. Revolver drawn only if operating cash is insufficient.

**Stop and confirm** the debt schedule. Are there refinancing windows in the holding period? Covenants tested?

### Step 6 — Tax shield
```
Pre-tax income     = EBIT − Interest
Cash taxes         = Pre-tax × effective rate
Tax shield value   = Interest × effective rate (descriptive only)
```

### Step 7 — Free cash flow + cash sweep
```
EBITDA
(−) Cash interest
(−) Cash taxes
(−) CapEx
(±) ΔWorking capital
(−) Mandatory amortisation
= Free cash flow available for sweep

If Free cash flow > min cash threshold:
  Sweep = MIN(Excess cash, Total prepayable debt)
Else:
  Revolver draw = shortfall (within revolver capacity)
```

### Step 8 — Exit
- Exit year (typically Year 5)
- Exit EBITDA = projected EBITDA in exit year
- Exit multiple = entry multiple ± any thesis-based delta (multiple expansion / contraction). Default conservative: same-as-entry multiple.
- Exit Enterprise Value = Exit EBITDA × Exit Multiple
- Exit Equity = Exit EV − closing net debt at exit
- Sponsor proceeds = Exit Equity (post fees if applicable)

### Step 9 — Returns
```
IRR        = (Sponsor Proceeds / Sponsor Equity)^(1/Holding period) − 1
MOIC       = Sponsor Proceeds / Sponsor Equity
Cash-on-Cash = (Sponsor Proceeds − Sponsor Equity) / Sponsor Equity
```

**Decompose the return** into three sources:
- **Multiple expansion** (or contraction): change in exit multiple × exit EBITDA
- **Operating improvement**: EBITDA growth × entry multiple
- **Deleveraging**: net debt paydown over the holding period

Report each as a $ contribution to the equity value and as a % of total return.

### Step 10 — Sensitivity (three tables, all 5×5)
1. **Entry multiple × Exit multiple** — primary; centre = both base
2. **Leverage at entry × Exit multiple** — capital-structure stress
3. **EBITDA growth × Exit multiple** — operating thesis

Centre cell = base-case IRR. Report MOIC alongside in a parallel table when space allows.

### Step 11 — Generate the workbook via `/xlsx`

Hand off to the `/xlsx` skill. Specify:

- File: `<Target>_LBO_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs`, `Assumptions`, `Sources_Uses`, `Operations`, `Debt` (per-tranche schedule with mandatory amort, sweep, revolver, interest, closing balance), `Returns` (IRR + MOIC by year), `Sensitivity`, `Output`.
- Named ranges: `Entry_Multiple`, `Entry_EBITDA`, `Leverage_Multiple`, `Tax_Rate`, `Exit_Year`, `Exit_Multiple`, `EBITDA_Growth_Y1` … `EBITDA_Growth_YN`, `Term_Loan_Rate`, `Revolver_Rate`, `Mezz_Rate`. Sources & Uses must tie via formula (a check row that highlights red on mismatch).
- Three sensitivity tables 5×5: Entry×Exit (primary), Leverage at Entry × Exit, EBITDA Growth × Exit. Each cell is a full IRR recalc; centre cell value equals the base-case IRR — a parallel MOIC table follows the same axis discipline.
- Each hardcoded operational input (margin, addback, working-capital ratio) has a cell comment naming the source filing or comparable transaction.

If `/xlsx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.xlsx`.

### Step 12 — Verify before delivering
Run the **Final Output Checklist** below.

---

<correct_patterns>

### Sources & Uses tie

```
USES                        $              SOURCES                          $
Equity purchase price       2,500          Senior Secured TLB (L+400)       1,200
Refinance existing debt       400          Senior Notes (5.5%)                400
Transaction fees               45          Sponsor equity                   1,395
Financing fees                 50
─────────────────────                      ─────────────────────
Total Uses                  2,995          Total Sources                    2,995  ✓
```

Both sides print the same total. Tie → ✓.

### Return decomposition

```
Sponsor equity at entry:                    $1,395
Sponsor proceeds at exit (Y5):              $4,200

Decomposition of value creation ($):
  Operating improvement (EBITDA growth × entry multiple):   $1,500   53%
  Multiple expansion (Δ multiple × exit EBITDA):              $400   14%
  Deleveraging (net debt paydown):                            $905   32%
─────────────────────────────────────                       ──────  ────
Total value created:                                        $2,805  100%

IRR (5-year):  24.6%      MOIC: 3.0×      Cash-on-Cash: 2.0×
```

The user sees where the return came from. If 70%+ comes from multiple expansion, the deal depends on a market-multiple call, not operations — flag.

### Debt schedule with sweep

```
TLB:                FY1     FY2     FY3     FY4     FY5
Opening balance     1,200   1,140   1,020     830     520
Mandatory amort       (12)    (12)    (12)    (12)    (12)
Cash sweep            (48)    (108)   (178)   (298)   (508) ← all-in by exit
Closing balance     1,140   1,020     830     520        0
Avg balance         1,170   1,080     925     675     260
Interest @ L+400    (84)    (78)    (67)    (49)    (19)
```

Sweep takes the TLB to zero by exit. Sponsor proceeds are the equity value, not equity + remaining debt.

### EBITDA addbacks disclosed separately

```
LTM EBITDA (reported):              $400
+ Non-recurring legal settlement:    $25  [Q4 FY24 PR]
+ Run-rate cost-out programme:       $40  [management presentation]
+ Owner compensation normalisation:  $15  [private company adjustment]
─────────────────────────────────  ────
Pro-forma LTM EBITDA:               $480

Entry multiple:    7.0× × $480 = $3,360 EV
                  (if reported EBITDA: 8.4× — reader can audit)
```

Reader sees both reported AND pro-forma; can audit each addback.

</correct_patterns>

<common_mistakes>

### WRONG: Sources ≠ Uses

```
Total Uses:    $3,000
Total Sources: $2,950   ← off by $50; deal isn't funded
```

Tie or fix. Common causes: forgot transaction or financing fees on the Uses side; rounding accumulated.

### WRONG: 100% sweep with $0 minimum cash

```
Default sweep: 100% of free cash; minimum cash = $0
```

Operationally unrealistic. Companies need working-capital cash. Default to 75% sweep above a $50–100mm minimum.

### WRONG: Multiple expansion baked in silently

```
Entry multiple: 7.0×
Exit multiple: 9.0×        ← $400+ of return implied here, no rationale
```

If the model assumes the multiple expands, the rationale must be explicit (sponsor builds platform, market re-rates, etc.) and the return decomposition must call out how much of total return that delta drives.

### WRONG: Deal expenses double-counted

```
Day 1 Uses: $45 transaction fees
Year 1 OpEx: $45 transaction fees   ← already paid at close, gone
```

One-time deal fees hit Day 1 only. Don't also add them to operating expenses going forward.

### WRONG: Entry leverage rule of thumb without peer-set

```
"Standard sponsor leverage of 6× — let's use 6×."
```

Cite the peer set. "Recent take-privates in this sub-sector entered at 5.8×–6.4× per [PitchBook 2025 LBO comp set]; using 6.0× as the centre." Or, if peer data isn't available, flag the decision as an assumption with the reasoning.

### TOP 5 ERRORS

1. Sources ≠ Uses (deal isn't funded)
2. 100% cash sweep with no minimum cash (operationally unrealistic)
3. Multiple expansion baked in without thesis or decomposition
4. Deal fees double-counted (capitalised AND expensed)
5. Entry leverage by rule of thumb instead of peer-set citation

</common_mistakes>

---

## Quality Rubric

Every LBO must maximise for:

1. **Sources tie to Uses** at close.
2. **Capital structure cited** to peer-set or transaction-comp leverage.
3. **EBITDA addbacks transparent** — reader sees reported and pro-forma side by side.
4. **Debt schedule complete** — mandatory + sweep + revolver, every tranche.
5. **Return decomposition** explicit — multiple expansion vs operating vs deleveraging.
6. **Sensitivity covers the dominant levers** — entry × exit, leverage × exit, EBITDA growth × exit.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Target>_LBO_<YYYYMMDD>.xlsx`.
- [ ] Sources & Uses tie row is a formula that lights red on mismatch.
- [ ] Sources = Uses on Day 1 (verified).
- [ ] Entry multiple cited to peer-set or transaction comp.
- [ ] EBITDA addbacks listed individually with sources.
- [ ] Debt schedule by tranche with mandatory amort, sweep, revolver, interest, closing balance.
- [ ] Cash sweep policy explicit (% of free cash above $X minimum cash).
- [ ] Tax shield from interest reflected in cash taxes.
- [ ] Exit assumptions explicit (year, multiple, basis).
- [ ] IRR / MOIC / cash-on-cash reported.
- [ ] Return decomposition: multiple expansion / operating / deleveraging contributions.
- [ ] Three 5×5 sensitivity tables, base case at centre.
- [ ] No deal-recommendation language. Returns presented; the IC / user decides.
