---
name: merger-model
description: Build a merger consequences analysis — pro-forma combined financials, accretion / dilution by year, deal financing analysis, and sensitivity. Use when the user asks for a merger model, accretion / dilution, M&A consequences, or "what does this deal do to EPS." Also the IB / IC primary lens on a strategic acquisition.
trigger: /merger-model
---

# Merger Model — Consequences Analysis

## Overview

A merger model that prices the deal, finances it, combines the two companies, layers in synergies and integration costs, and reports accretion / dilution to EPS year by year — with the break-even year and pro-forma leverage explicit. The output answers "should our EPS go up or down because we did this deal" and over what window.

---

## Critical Constraints — read these first, every time

1. **Synergies are run-rate, with a ramp.** Don't credit Year 1 with full synergies. Default ramp: 25% / 60% / 90% / 100% across Years 1–4. Adjust per management plan with citation.
2. **Integration costs offset synergies in the early years.** Typically front-loaded — 60%/30%/10% across Years 1–3. **Net synergies (synergies minus integration cost) is the right number to assess on accretion in early years.**
3. **Deal financing matters.** Cash deal → uses balance sheet cash + new debt. Stock deal → issues new shares (uses merger ratio). Mix → both. The accretion calc depends on the financing.
4. **For stock deals: use the merger ratio, not just the cash equivalent.** The exchange ratio determines new share issuance.
5. **Tax treatment of the deal affects basis.** Stock-for-stock typically tax-free to selling shareholders; cash deal triggers gain. Asset deals create stepped-up basis with depreciation/amortisation tax shield — surface explicitly.
6. **Goodwill is consideration minus book equity (not minus market cap).** And goodwill doesn't amortise — it's tested for impairment.
7. **Pro-forma leverage tested against covenants.** If the combined `Debt / EBITDA` breaches a covenant threshold, surface — the deal may not close as structured.
8. **Financing fees + transaction fees are uses on Day 1.** Same discipline as LBO.
9. **Verify with the user at four checkpoints** — deal terms → pro-forma combined → accretion / dilution by year → sensitivity — before finishing.

---

## Workflow

### Step 1 — Confirm the deal
- Acquirer (ticker)
- Target (ticker / private company)
- Announced or hypothetical?
- Structure: cash / stock / mix (split %)
- Premium to target's unaffected price (typical: 20–40%)
- Expected close date (impacts timing of synergies)

### Step 2 — Pull standalone financials (delegate to `filings-explorer`)
For acquirer AND target:
- LTM revenue, EBITDA, EBIT, NI, EPS
- Diluted shares
- Total debt and cash
- 3-year forward consensus or management guide (each company's standalone projections)

### Step 3 — Set deal terms
- **Offer price** (per target share): unaffected price × (1 + premium)
- **Deal value (equity)**: offer price × target diluted shares
- **Deal value (EV)**: equity value + target net debt
- **Cash component**: $X
- **Stock component**: target shares × exchange ratio = new acquirer shares issued
- **Exchange ratio**: (offer price / acquirer share price) for the stock-funded portion; pin at announcement-date acquirer price

**Stop and confirm** the deal terms with the user.

### Step 4 — Sources & Uses (mirror LBO discipline)
**Uses:**
- Equity purchase price (cash portion)
- Refinance target's existing debt (if applicable)
- Transaction fees (1.5–2.0% of EV)
- Financing fees (2.5–3.5% of new debt issued, if any)

**Sources:**
- Acquirer balance-sheet cash (typically a portion, not all)
- New debt issued (TLB, notes, etc.)
- New stock issued (for stock portion of consideration)
- Existing acquirer cash for fees

### Step 5 — Build pro-forma combined
**Income statement (Year 1):**
```
Revenue (acquirer)     +  Revenue (target)
+ Revenue synergies (Year 1 ramped, e.g., 25% of run-rate)
= Pro-forma Revenue

EBITDA (acquirer)      +  EBITDA (target)
+ Cost synergies (Year 1 ramped)
− Integration costs (Year 1, front-loaded)
= Pro-forma EBITDA

(− Incremental D&A from PPA write-up, if asset deal)
(+ Acquirer D&A + Target D&A − Acquired-PPE goodwill amort if any)
= Pro-forma EBIT

(− Incremental interest from new debt)
(− Acquirer + Target standalone interest)
= Pro-forma EBT

(× pro-forma tax rate)
= Pro-forma Net Income

(÷ Pro-forma diluted shares = Acquirer shares + new shares issued)
= Pro-forma EPS

vs. Acquirer standalone EPS (without the deal)
= Accretion / (Dilution) %
```

**Stop and confirm** the Year 1 pro-forma with the user.

### Step 6 — Accretion / dilution by year
Project Years 1–4 with the synergy ramp and integration cost decay:

| Year | Synergies (% of run-rate) | Integration costs ($) | Pro-forma EPS | Standalone EPS | Accretion / (Dilution) % |
|---|---|---|---|---|---|
| Y1 | 25% | High | $X.XX | $X.XX | -X.X% (dilutive) |
| Y2 | 60% | Medium | $X.XX | $X.XX | +X.X% (accretive) |
| Y3 | 90% | Low | $X.XX | $X.XX | +X.X% |
| Y4 | 100% | Zero | $X.XX | $X.XX | +X.X% |

**Break-even year** = the first year accretion turns positive. Surface explicitly.

### Step 7 — Pro-forma leverage check
```
Pro-forma Net Debt = Acquirer net debt + Target net debt + New debt issued
Pro-forma EBITDA   = Year 1 pro-forma EBITDA (reported)
Pro-forma Leverage = Pro-forma Net Debt / Pro-forma EBITDA
```

Compare to:
- Acquirer standalone leverage
- Acquirer covenant thresholds (if disclosed in 10-K)
- Industry comparable acquirers' post-deal leverage

If pro-forma leverage breaches a covenant, **flag** — the deal may need to be restructured.

### Step 8 — Goodwill / PPA
```
Consideration (equity)            = $X
(−) Target book equity            = $Y
(+) Step-up to fair value (PPE / intangibles, if asset deal):
       Identifiable intangibles    = $Z
       PPE write-up                = $W
       Deferred tax adjustment     = $V
(=) Goodwill                       = $X − $Y − $Z − $W + $V
```

In a stock deal (most strategic mergers), the structure typically doesn't trigger asset step-up — goodwill simply equals consideration minus book equity. Asset deals (less common) generate stepped-up basis with new depreciation/amortisation that creates a tax shield.

### Step 9 — Sensitivity (three tables)
1. **Premium × Synergy size** — primary
2. **Financing mix (cash %) × Premium** — financing structure
3. **Synergy ramp speed × Integration cost size** — execution risk

Centre cell = announced terms / base assumption. Report Year-2 accretion as the headline metric (Year 1 is dominated by integration costs).

### Step 10 — Generate the workbook via `/xlsx`

Hand off to the `/xlsx` skill. Specify:

- File: `<Acquirer>_<Target>_Merger_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs`, `Assumptions`, `Standalone_Acquirer`, `Standalone_Target`, `Deal_Terms`, `ProForma` (combined IS + BS + capital structure), `Synergies` (ramp curve + integration costs), `Accretion` (per-year EPS bridge), `Sensitivity`, `Output`.
- Named ranges: `Premium`, `Stock_Cash_Mix` (acquirer stock %), `Exchange_Ratio` (when stock), `Run_Rate_Cost_Synergies`, `Run_Rate_Revenue_Synergies`, `Synergy_Ramp_Y1` … `Synergy_Ramp_Y3`, `Integration_Cost_Y1` … `Integration_Cost_Y3`, `Tax_Rate`, `Acquirer_Cost_of_Debt`, `Goodwill`. Deal terms reference these names; pro-forma reads from standalone sheets + deal terms via formulas.
- Three sensitivity tables 5×5: Premium × Synergy Size (primary), Financing Mix × Premium, Synergy Ramp × Integration Cost. Centre cell value equals the base-case Year-2 accretion (the headline metric).
- Sources & Uses row carries a formula tie-out that lights red on mismatch.

If `/xlsx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.xlsx`.

### Step 11 — Verify before delivering
Run the **Final Output Checklist** below.

---

<correct_patterns>

### Synergy ramp + integration cost layout

```
Year:                              Y1      Y2      Y3      Y4
Run-rate synergies                $400   $400    $400    $400
× Realisation rate                 25%     60%     90%    100%
= Realised synergies              $100   $240    $360    $400

Integration costs                  $80    $40     $10      $0   (front-loaded, decays)

NET to EBITDA                     +$20  +$200   +$350   +$400

[management presentation, 2026-04-15, p. 18]
```

The reader sees synergies and integration as parallel rows. Net is what hits the P&L.

### Accretion / dilution table with break-even

```
                          Y1        Y2        Y3        Y4
Pro-forma EPS           $5.20     $6.10     $6.85     $7.30
Standalone EPS          $5.50     $5.85     $6.20     $6.55
Accretion / (Dilution) -5.5%     +4.3%     +10.5%    +11.5%
                       (dilut.)  ←─── break-even Y2 ───→

Pro-forma leverage      3.4×      3.0×      2.6×      2.2×
Acquirer covenant       4.0×      ✓         ✓         ✓
```

Break-even year is highlighted. Pro-forma leverage tested against covenant in every year.

### Stock deal share calculation

```
Cash + Stock deal — 50/50 split:
Target diluted shares:              200mm
Offer per share:                    $50

Total deal equity:                  $10,000mm
  Cash portion (50%):               $5,000mm
  Stock portion (50%):              $5,000mm

Acquirer share price (announcement): $100
Exchange ratio:                     0.5× (offer $50 / $100 stock)
New acquirer shares issued:         200mm × 0.5 × 50% = 50mm

Pro-forma diluted shares:           Acquirer existing + 50mm new
```

The exchange ratio + the stock-portion percentage drives new share issuance. Reader audits the math.

</correct_patterns>

<common_mistakes>

### WRONG: Year 1 credited with full synergies

```
Year 1 EBITDA = Combined + $400mm synergies   ← run-rate, no ramp
```

Synergies don't materialise on Day 1. Use a ramp — 25%/60%/90%/100% is the conventional assumption; cite if using a different curve.

### WRONG: Integration costs ignored

```
Net synergies = $400mm in Year 1   ← forgot the $80mm of integration spend
```

Integration costs are real. They typically run 15–25% of run-rate synergies in aggregate, front-loaded. Net synergies = synergies minus integration cost.

### WRONG: Stock deal modeled as cash equivalent

```
Stock portion: $5,000mm   ← treated as cash; pro-forma shares unchanged
```

In a stock deal, new shares are issued. Pro-forma share count goes up, EPS dilutes per share (offset by combined NI). Use the exchange ratio.

### WRONG: Goodwill from market cap, not book equity

```
Goodwill = Consideration − Target Market Cap   ← WRONG
```

Goodwill = Consideration − Target Book Equity (with PPA step-ups for asset deals). Market cap is the price; book equity is the basis. The difference is goodwill plus identifiable intangibles.

### WRONG: Pro-forma leverage breach not flagged

```
Pro-forma Leverage = 4.5×, covenant = 4.0×   ← not surfaced
```

If the deal breaches a covenant, the deal team must restructure (more cash, less debt, smaller premium, etc.). This is a deal-killer until resolved — flag immediately.

### TOP 5 ERRORS

1. Year 1 credited with full run-rate synergies (no ramp)
2. Integration costs ignored (synergies looked artificially good)
3. Stock deal modelled as cash equivalent (forgot new share issuance)
4. Goodwill computed from market cap instead of book equity
5. Covenant breach in pro-forma leverage not flagged

</common_mistakes>

---

## Quality Rubric

Every merger model must maximise for:

1. **Synergy realism** — explicit ramp curve, cited, with integration costs offsetting in early years.
2. **Accurate financing structure** — cash / stock / mix correctly modeled, share dilution from stock portion captured.
3. **Goodwill / PPA discipline** — based on book equity (and step-ups for asset deals), not market cap.
4. **Pro-forma leverage tested** against covenants and peer-set transaction precedents.
5. **Year-by-year accretion** with break-even year explicit.
6. **Sensitivity** covers premium, synergies, financing, ramp speed.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Acquirer>_<Target>_Merger_<YYYYMMDD>.xlsx`.
- [ ] Year-2 accretion is the centre-cell metric on the Premium × Synergy sensitivity table; flexing either axis recomputes from formulas.
- [ ] Deal terms confirmed (structure, premium, exchange ratio if stock).
- [ ] Sources = Uses on Day 1.
- [ ] Standalone financials pulled and cited for both companies.
- [ ] Synergies modelled with explicit ramp curve, cited.
- [ ] Integration costs modelled separately, front-loaded.
- [ ] Pro-forma combined P&L through Year 4.
- [ ] Pro-forma diluted shares correctly account for stock issuance (if any).
- [ ] Accretion / dilution table by year with break-even year highlighted.
- [ ] Goodwill calculated from book equity (and step-ups if asset deal).
- [ ] Pro-forma leverage tested against acquirer covenants — breach flagged if any.
- [ ] Three sensitivity tables (premium × synergies, financing × premium, ramp × integration).
- [ ] No "do the deal" language. Numbers reported; the board / IC decides.
