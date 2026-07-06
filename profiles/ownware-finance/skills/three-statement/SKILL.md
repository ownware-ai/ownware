---
name: three-statement
description: Build an integrated three-statement financial model — projected income statement, balance sheet, and cash-flow statement, all linked. Use when the user asks for a full financial model, three-statement model, integrated model, or wants projected financials with the balance sheet that ties. Also serves as the foundation under DCF, LBO, and merger models.
trigger: /3sm
---

# Three-Statement Model

## Overview

An integrated P&L / Balance Sheet / Cash Flow model that **balances every period**. Cash on the BS reconciles to closing cash from the CF. Retained earnings rolls forward correctly. Total assets = liabilities + equity, in every projection year. If any of those fail, the model is broken — and we surface it explicitly rather than paper over.

---

## Critical Constraints — read these first, every time

1. **The balance sheet must balance — every period.** `Total Assets = Total Liabilities + Total Equity`, all years. If it doesn't tie, do not deliver — fix or surface.
2. **Cash on BS = closing cash from CF, every period.** Hard tie.
3. **Retained earnings rolls forward.** `RE_t = RE_{t-1} + Net Income_t − Dividends_t`. Anything else is a bug.
4. **No hardcoded values in derived cells.** Every projected line is a formula referencing assumptions or other lines. Hardcoded only: actuals, assumption drivers, opening BS items.
5. **Working capital changes flow from BS, not assumed in CF.** ΔAR, ΔInventory, ΔAP each come from the BS movement; CF presents them, doesn't define them.
6. **CapEx and D&A are linked to PPE on the BS.** `PPE_t = PPE_{t-1} + CapEx_t − D&A_t − Disposals_t`. The CF and BS share the same numbers, not parallel ones.
7. **Debt schedule lives separately and feeds three places** — interest expense on P&L, debt balance on BS, principal cash flow on CF.
8. **Verify with the user at three checkpoints** — after assumptions, after the projected P&L, after the first balanced period — before completing the rest.

---

## Workflow

### Step 1 — Pull historicals (delegate to `filings-explorer`)
Required:
- 3 years of P&L (revenue → net income, all line items the company reports)
- 3 years of BS (current and non-current assets/liabilities, equity composition)
- 3 years of CF (operating, investing, financing)
- Latest debt schedule (tranche, rate, maturity, covenants if disclosed)

If any are missing, **stop and ask** — do not estimate.

### Step 2 — Set drivers
| Category | Driver |
|---|---|
| Revenue | YoY growth % per year (consensus, management guide, or analyst-set) |
| Gross margin | % of revenue per year |
| Operating expenses | S&M, R&D, G&A each as % of revenue |
| D&A | % of opening PPE OR % of revenue (be consistent) |
| Tax rate | Effective rate per year |
| CapEx | % of revenue |
| Working capital | DSO, DIO, DPO (days) — translates to BS line items |
| Debt | Schedule of principal repayments, rate per tranche, refinancings |
| Dividends + buybacks | $ per year or % of net income |

**Stop and confirm with the user** that the drivers reflect their case (Bear / Base / Bull or a single point).

### Step 3 — Project the income statement
```
Revenue          = Revenue_{t-1} × (1 + Growth%_t)
Gross Profit     = Revenue × Gross Margin%
S&M              = Revenue × S&M%
R&D              = Revenue × R&D%
G&A              = Revenue × G&A%
EBIT             = Gross Profit − (S&M + R&D + G&A)
Interest Expense = (from debt schedule, see Step 5)
EBT              = EBIT − Interest
Taxes            = EBT × Effective Rate
Net Income       = EBT − Taxes
Dividends        = (per assumption)
Retained NI      = Net Income − Dividends
```

### Step 4 — Project the balance sheet
**Operating items (driven by P&L and assumptions):**
- AR = (DSO / 365) × Revenue
- Inventory = (DIO / 365) × COGS
- AP = (DPO / 365) × COGS
- PPE: opening + CapEx − D&A − disposals
- Goodwill: held flat (unless impairment scheduled)
- Other intangibles: amortise per schedule

**Equity items:**
- Common stock: held flat (unless issuance / buyback)
- Retained earnings: opening + Net Income − Dividends
- Other comprehensive income: from FX / pensions / other (often held flat)

**Debt items:** from the debt schedule (Step 5).

**Cash:** **plug** — derived from the CF statement, NOT assumed. This is the linchpin.

### Step 5 — Build the debt schedule
| Tranche | Opening Balance | Rate | Mandatory Amort | Sweep / Optional | Closing Balance | Interest |
|---|---|---|---|---|---|---|
| Senior Secured Term Loan A | $X | L+250bp | $Y/yr | (sweep order #1) | ... | (avg balance × rate) |
| Senior Notes | $X | 5.5% fixed | bullet | — | $X | $X × 5.5% |
| Revolver | $0 | L+200bp | — | — | $0 | unused fee |

Interest expense from this schedule feeds the P&L. Principal payments feed the financing section of CF. Closing balances feed the BS.

### Step 6 — Derive the cash flow statement
**Operating activities:**
```
+ Net Income
+ D&A
+ Stock-based compensation
± ΔWorking capital (from BS movements)
+ Other non-cash items
= Cash from Operating
```

**Investing activities:**
```
− CapEx
− Acquisitions
+ Divestitures
± Investments
= Cash from Investing
```

**Financing activities:**
```
± Net debt issuance / repayment (from debt schedule)
− Dividends
− Buybacks
± Other equity issuance
= Cash from Financing
```

**Closing cash = Opening cash + (Op + Inv + Fin)**.

### Step 7 — Tie cash on BS = closing cash on CF
Plug cash on the BS with the closing-cash number from the CF. **Now run the balance check:** `Total Assets = Total Liab + Total Equity`. If it doesn't tie:
- Off by a small number? Probably a rounding accumulation — find and fix.
- Off by a meaningful number? You missed a flow somewhere (typically: stock-based comp not added back in CF, or an asset/liability movement not reflected). Walk every BS line and confirm there's a corresponding CF entry.

**Stop and confirm with the user** that the first projected period balances correctly before finishing the rest.

### Step 8 — Project remaining periods
Once Year 1 balances cleanly, the rest follow the same formulas. Run the balance check on every period before delivering.

### Step 9 — Generate the workbook via `/xlsx`

Hand off to the `/xlsx` skill. Specify:

- File: `<Ticker>_3SM_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs` (historicals + drivers), `Assumptions` (per-period driver overrides), `IS` (income statement), `BS` (balance sheet), `CF` (cash flow), `Debt` (debt schedule), `Output` (summary metrics: revenue, EBITDA, FCF, leverage, cash trajectory). Cash flow plug ties to Δcash on BS.
- Named ranges for every driver: `Revenue_Growth_Y1` … `Revenue_Growth_YN`, `Gross_Margin_Y1`, `SGA_Pct_Y1`, `Tax_Rate`, `CapEx_Pct_Rev`, `NWC_Pct_DRev`, `Interest_Rate_Term`, `Interest_Rate_Revolver`. Drivers live on `Assumptions`; statements reference the names.
- Cross-sheet formulas: every BS line that depends on IS or CF references those sheets directly (`=IS!B12 + ...`); cash on BS is computed as prior-period cash + CF total. The balance check (Assets = L + E) is a formula on every period and lights up red on mismatch.
- Each historical hardcoded input has a cell comment with the source filing + page + line.

If `/xlsx` reports a missing-Python error, surface its install instruction and stop. Do not deliver an ASCII model.

### Step 10 — Verify before delivering
Run the **Final Output Checklist** below.

---

<correct_patterns>

### Cash plug derived from CF, not assumed

```
BS row: Cash = closing cash from CF statement (formula reference)
NOT:    Cash = $X (hardcoded forecast)
```

The cash line on the BS is the LAST line populated. It's whatever falls out of the CF, not an independent assumption. If the model "works" only because cash was hardcoded, the model is broken.

### Working capital flows from BS to CF

```
P&L:  Revenue, COGS               (drivers of BS items)
BS:   AR = (DSO/365) × Revenue    (formula)
BS:   ΔAR = AR_t − AR_{t-1}        (calculated)
CF:   (Increase) in AR = − ΔAR     (formula reference)
```

CF "uses" cash when AR grows; "sources" cash when AR shrinks. The CF doesn't define ΔAR — it presents the BS movement.

### Balance check row

```
Period:                         FY24A    FY25E    FY26E    FY27E

Total Assets:                   $X       $X       $X       $X
Total Liab + Equity:            $X       $X       $X       $X
Δ (Assets − Liab&Eq):           $0       $0       $0       $0  ← MUST be zero
Δ as % of total:                0.00%    0.00%    0.00%    0.00%
```

A row that prints `$0` in every period is the audit trail. Any non-zero entry is a bug — find it before delivering.

### Debt schedule feeds three places

```
Debt Schedule:
- Senior Notes interest = $50mm/yr   →  P&L interest expense line
- Senior Notes balance = $1,000mm    →  BS long-term debt line
- Senior Notes principal = $0/yr (bullet)  →  CF financing (zero)

(when refinanced in Y4:)
- Repayment = $1,000mm               →  CF financing (use of cash)
- New issuance = $1,000mm new tranche →  CF financing (source of cash)
- Closing balance = $1,000mm          →  BS LT debt
```

One debt schedule, three downstream consumers. Don't model interest separately from balance separately from cash flow.

</correct_patterns>

<common_mistakes>

### WRONG: Cash hardcoded, balance check skipped

```
BS: Cash = $500mm (assumption)
... model "balances" because everything else is hardcoded too
```

Cash is the plug. If you hardcode it, you've not built an integrated model.

### WRONG: D&A and CapEx not tied to PPE

```
P&L: D&A = Revenue × 4%
BS:  PPE = $X (held flat or randomly grown)
CF:  CapEx = Revenue × 5%
```

Three separate, unlinked numbers. Correct: PPE_t = PPE_{t-1} + CapEx_t − D&A_t. Then D&A's % of opening PPE is the assumption driver, and CapEx flows from PPE intensity.

### WRONG: Retained earnings reset

```
RE_FY25 = $X (entered fresh as an assumption)
```

Retained earnings ROLLS FORWARD. Resetting it breaks the equity / net income link.

### WRONG: Off-balance-sheet operating leases ignored

For most companies under IFRS 16 / ASC 842, operating leases are now on-balance-sheet. Don't pull lease commitments only from the disclosure footnote — use the recognised right-of-use asset and lease liability.

### WRONG: Sign errors in CF

```
CF: (Increase) in AR = + $50mm   ← WRONG
```

AR increase is a USE of cash, so it appears with a negative sign in the CF. Watch the sign convention; verify that the CF total ties to the cash movement on the BS.

### TOP 5 ERRORS

1. Cash hardcoded instead of derived from CF (model isn't actually integrated)
2. PPE / D&A / CapEx not linked (three numbers that should be one chain)
3. Retained earnings reset each period (breaks equity → NI link)
4. Working capital signs wrong in CF (treat increases as sources instead of uses)
5. Balance check missing or skipped (silent bugs)

</common_mistakes>

---

## Quality Rubric

Every three-statement model must maximise for:

1. **Balance every period** — Total Assets = Total Liab + Equity, in every projected year.
2. **Cash tie** — BS cash = CF closing cash, every period.
3. **PPE chain** — D&A and CapEx feed PPE; one chain, not three independent numbers.
4. **Debt schedule integrity** — one schedule feeds P&L interest, BS debt, and CF principal.
5. **No hardcoded derived cells** — every projection is a formula traceable back to a driver.
6. **Working capital flows** — defined on BS, presented on CF.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Ticker>_3SM_<YYYYMMDD>.xlsx`.
- [ ] Balance check (Assets − L − E) is a formula on every projected period; mismatch lights red.
- [ ] 3 historical years pulled from filings, cited.
- [ ] Drivers documented in an assumptions block, each labelled.
- [ ] Income statement projected line by line, formulas only.
- [ ] Balance sheet projected with cash as the plug.
- [ ] Debt schedule built; interest, balance, and principal cash flow consistent.
- [ ] Cash flow statement derived from BS movements + non-cash adjustments.
- [ ] Cash on BS = closing cash on CF, every period (verified).
- [ ] Total Assets = Total Liab + Equity, every period (balance check row prints `$0`).
- [ ] Retained earnings rolls forward correctly.
- [ ] No hardcoded numbers in derived cells.
- [ ] No investment / accounting advice. The model is a frame; the user / accountant signs off.
