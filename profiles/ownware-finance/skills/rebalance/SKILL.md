---
name: rebalance
description: Build an allocation rebalance plan with tax-loss harvesting overlay — current vs target allocation, recommended trades, tax impact (taxable / tax-deferred separated), TLH opportunities, wash-sale guards. Use when the user asks for a rebalance, allocation adjustment, drift correction, or TLH analysis. Advisor signs off on trades.
trigger: /rebalance
---

# Rebalance — Allocation + Tax-Loss Harvest

## Overview

A trade list to bring the portfolio back to its target allocation, layered with tax-loss harvesting opportunities. Distinguishes taxable from tax-deferred accounts (the math differs), guards against wash sales, and surfaces tax impact transparently. The advisor signs off; the agent stages.

---

## Critical Constraints — read these first, every time

1. **Taxable vs tax-deferred treated differently.** TLH only matters in taxable accounts. Rebalancing in tax-deferred is "free" tax-wise. Always distinguish.
2. **Wash-sale rule guarded.** A loss harvest followed by buying a substantially identical security within 30 days disallows the loss. Replacement security must be similar but not identical.
3. **Cite cost basis per lot.** Long-term vs short-term lots have different tax treatment. Specify which lots are being sold.
4. **Don't sell low without reason.** Rebalancing means selling winners and buying losers (mechanical drift correction). TLH means selling losers in taxable. Don't conflate the two.
5. **Tax impact transparent.** $X realised in long-term losses, $Y in short-term gains, net $Z to client tax bill at marginal rate W%.
6. **No specific advice.** The advisor signs off. The pack stages.
7. **Cite custodian as-of date.** Allocation drifts; trades stale within hours of pulled data.

---

## Workflow

### Step 1 — Confirm scope
- Account scope (full household / single account / specific accounts)
- Target allocation (from financial plan or stated goals)
- Drift trigger (default ±5% on any asset class; ±10% triggers automatic rebalance recommendation)
- TLH inclusion (yes / no — usually yes if any taxable accounts have unrealised losses)

### Step 2 — Pull current allocation
- Holdings + market values per account
- Cost basis per lot
- Account type (taxable / tax-deferred / Roth)

### Step 3 — Identify drift
For each asset class:
- Current weight
- Target weight
- Drift ($, %)
- Within band? (✓ / ⚠ / ✗)

### Step 4 — Identify TLH opportunities
For each taxable account:
- Lots showing > $1K unrealised loss
- Long-term vs short-term loss
- Replacement security selected (similar but not identical)

### Step 5 — Build trade list
**Tax-deferred accounts (rebalance freely):**
- Sell list, with weights
- Buy list, with weights

**Taxable accounts (rebalance + TLH):**
- TLH sells: which lots, total realised loss ($)
- Replacement buys: similar securities
- Rebalance trades: minimised to use harvested losses to offset gains

### Step 6 — Tax impact summary
- Realised long-term losses: $X
- Realised long-term gains: $Y
- Net long-term: $X − $Y = $Z
- Realised short-term losses: $A
- Realised short-term gains: $B
- Net short-term: $A − $B = $C
- Estimated tax savings (LT loss × 20% + ST loss × marginal): $D

### Step 7 — Wash-sale guard verification
Confirm replacement securities don't trigger wash-sale. Specifically:
- Sold security and replacement must not be substantially identical (same fund family, similar ETF tracking same index, etc., is risky)
- Buy in IRA after sell in taxable also triggers wash-sale (less commonly known)

### Step 8 — Generate the trade-list workbook via `/xlsx`

Hand off to `/xlsx`. The trade list is a structured staging document — perfect for a workbook the advisor reviews and submits to the trading desk. Specify:

- File: `<Client>_Rebalance_Trades_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs` (account scope + target allocation + bands), `Drift` (per-account: target / current / drift / band-status), `TLH_Opportunities` (taxable accounts: lot-by-lot harvestable losses sorted by amount), `Trades_TaxDeferred` (drift-correction-only trade list), `Trades_Taxable` (drift + TLH combined trade list), `WashSale_Check` (each sell pairs with proposed replacement; verify column lights red on wash-sale risk), `Output` (per-account summary: cash raised, cash deployed, net taxable gain/loss, expected tax impact at marginal rate).
- Named ranges: `Marginal_Tax_Rate`, `Long_Term_Cap_Gains_Rate`, `Wash_Sale_Window_Days` (default 30). Tax impact computed via formulas referencing these.
- Trade-list columns: Account, Action (Sell / Buy), Symbol, Shares, Estimated Price, Estimated $, Lot ID (for TLH), Tax Lot Date, Realized Gain/Loss, Replacement Symbol (for TLH sells), Wash-Sale Verified (Y/N).
- Conditional formatting: drift % (green within band, yellow approaching, red breached); wash-sale verified (red if N; green if Y).

**Advisor-signoff framing.** The workbook is the staged trade list — the advisor reviews, signs off, then submits to the trading desk. The agent never executes trades.

If `/xlsx` reports a missing-Python error, surface its install instruction and stop.

### Step 9 — Run **Final Output Checklist**

---

<correct_patterns>

### Drift table per account type

```
### Drift — Taxable Brokerage (Account #4729)

| Asset Class       | Target | Current | Drift  | Within Band |
| US Equity (Large) | 35%    | 41%     | +6%    | ⚠ outside   |
| US Equity (Small) | 10%    | 11%     | +1%    | ✓ within    |
| Intl Equity       | 15%    | 12%     | -3%    | ✓ within    |
| Bonds (Core)      | 30%    | 25%     | -5%    | ✓ within    |
| Bonds (HY)        | 5%     | 6%      | +1%    | ✓ within    |
| Cash              | 5%     | 5%      | 0%     | ✓ within    |

Source: [Custodian statement, holdings as of 2026-04-30].

Drift bands: ✓ within ±5% / ⚠ ±5-10% / ✗ > ±10%.
```

Reader sees what's outside band, by account.

### TLH lot detail with replacement

```
### TLH Opportunities — Taxable Brokerage (Account #4729)

| Security  | Lot Date    | Cost Basis | Current   | Unrealised | LT/ST | Action                                |
| VTI       | 2024-09-10  | $42,000    | $36,500   | -$5,500    | LT    | Sell, harvest $5,500 LT loss          |
| VEA       | 2024-11-22  | $14,000    | $12,400   | -$1,600    | ST*   | Sell, harvest $1,600 ST loss          |
| VXUS      | 2024-08-05  | $9,500     | $8,200    | -$1,300    | LT    | Sell, harvest $1,300 LT loss          |

*Becomes long-term on 2026-11-22; sell now if tax bracket favours short-term loss now.

### Replacement Buys (wash-sale guarded)

| Sold      | Replace With                   | Wash-Sale Check                                  |
| VTI       | ITOT (iShares Core S&P Total)  | Different fund family, different index — CLEAN  |
| VEA       | IEFA (iShares Core MSCI EAFE)  | Different fund family, different index — CLEAN  |
| VXUS      | IXUS (iShares Core MSCI Total Intl) | Different fund family, different index — CLEAN |

Total LT loss harvested: $6,800. Total ST loss harvested: $1,600.

Estimated tax savings (using current LT/ST capital gains rates, marginal 32% income):
LT loss × 20%   =  $1,360
ST loss × 32%   =  $   512
                 ────────
Total savings:    $1,872
```

Reader sees: each lot, harvest amount, replacement security, wash-sale verification, total tax savings.

### Tax-deferred rebalancing — separate

```
### Rebalance Trades — IRA (Account #8311) — tax-deferred

Drift: US Equity Large +4% (within band), Bonds Core -4% (within band).

Recommended trades (drift correction without tax-loss overlay since tax-deferred):

| Sell                  | Quantity | Buy                       | Quantity | Reason             |
| US Total Stock (FZROX)| $8,000   | Total Bond (FXNAX)         | $8,000   | Drift back to target |

No tax impact — all transactions in tax-deferred account.
```

Tax-deferred rebalancing is mechanical and tax-free. Listed separately so the impact is clear.

</correct_patterns>

<common_mistakes>

### WRONG: Mixing taxable and tax-deferred TLH

```
"Tax-loss opportunity across all accounts: $8,400."
```

TLH applies only to taxable. Tax-deferred losses don't count for TLH purposes. Be explicit which accounts.

### WRONG: Wash-sale violation

```
"Sell VTI in taxable. Buy VTI back in IRA next week."
```

Wash-sale rule covers buying substantially identical security in ANY account (including tax-advantaged) within 30 days of the sale. The loss is disallowed.

### WRONG: Selling at a gain in TLH context

```
"TLH: sell $X of US Large Cap (cost basis lower than current)."
```

You can't TLH a gain. TLH harvests losses. Selling a winner triggers a gain (taxable event). That's rebalancing, not TLH.

### WRONG: Replacement is the same fund family

```
"Sell VTI. Buy VTSAX (Vanguard Total Stock Market mutual fund)."
```

VTI and VTSAX track the same index from the same fund family — IRS may rule them substantially identical. Use a different fund family or different index.

### WRONG: No cost basis detail

```
"Sell $50K of US Equity to bring back to target."
```

Which lots? Long-term or short-term? Cost basis matters. Specify.

### TOP 5 ERRORS

1. Mixing taxable and tax-deferred TLH (TLH only in taxable)
2. Wash-sale violation (buying identical security in 30-day window — including in IRA)
3. "TLH" applied to a gain (it's not TLH, it's rebalancing)
4. Replacement security from same fund family or tracking same index
5. Trade list without cost basis / lot detail

</common_mistakes>

---

## Quality Rubric

Every rebalance / TLH plan must maximise for:

1. **Account-type discipline** — taxable vs tax-deferred separately handled.
2. **Drift surfaced per account** — current / target / drift / within band.
3. **TLH guarded** — wash-sale verified for each replacement.
4. **Lot-level detail** — specifies which lots, LT vs ST.
5. **Tax impact transparent** — realised gains/losses, net, estimated savings.
6. **No advice** — pack stages; advisor signs off.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Client>_Rebalance_Trades_<YYYYMMDD>.xlsx`.
- [ ] Wash-Sale Verified column shows green Y on every TLH sell row; any N row must be resolved before delivering.
- [ ] Account scope and target allocation explicit.
- [ ] Drift table per account, with bands.
- [ ] TLH opportunities listed per taxable account, lot-by-lot.
- [ ] Replacement security listed for each TLH sell, wash-sale verified.
- [ ] Trade list separated: tax-deferred (drift correction only) and taxable (drift + TLH).
- [ ] Tax impact summary: LT/ST realised gains and losses, estimated savings.
- [ ] Wash-sale guard: replacement is from different fund family AND tracks different index.
- [ ] No replacement that triggers wash-sale via IRA / spouse account / partial position.
- [ ] All numbers cited from custodian with as-of date.
- [ ] Advisor sign-off line at end.
