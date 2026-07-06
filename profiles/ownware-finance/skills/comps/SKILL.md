---
name: comps
description: Build a comparable company analysis with 5–8 publicly-traded peers, statistical summary (median + 25th/75th), and an implied valuation range applied to the target's metrics. Use when the user asks for comps, trading comps, peer multiples, relative valuation, or how a company stacks up against peers; or when a DCF / pitchbook / IC memo needs the comps leg.
trigger: /comps
---

# Comps — Comparable Company Analysis

## Overview

Trading comps that use the same metric definitions across every peer, flag outliers, and translate peer multiples into an implied valuation range for the target. The user gets a one-glance peer table and a defensible relative-valuation read on the target.

---

## Critical Constraints — read these first, every time

1. **Same metric definitions across every peer.** LTM is LTM, NTM is NTM, never mix. Calendarised vs fiscal years — convert and label. GAAP vs non-GAAP — pick one, label, stay consistent.
2. **Currency normalised.** Multiples are unitless, but if peer EBITDA is reported in EUR and the target is USD, normalise revenue / margins to a common currency at the latest spot before tabulating.
3. **5–8 peers.** Fewer than 5 is too thin to compute meaningful percentiles; more than 8 dilutes the signal. Document why each peer is in.
4. **Peers must be operationally comparable, not just SIC-comparable.** Same business model, customer mix, and growth/margin profile. A pure-play and a conglomerate in the same industry are not peers.
5. **Median, 25th and 75th percentiles — not the mean.** Mean is dragged by outliers. Use median + IQR.
6. **Outlier flags.** Any peer outside `median ± 1.5 × IQR` on a multiple is flagged in `Notes` and considered for exclusion.
7. **Live multiples cite the date.** `[FactSet, 2026-05-06 close]` for every multiple; or `[Yahoo Finance / IR site, <date>]` for the free-tier fallback.
8. **No fabricated comps.** If you cannot verify a peer is publicly traded with the metrics you're tabulating, exclude them. Don't reach.

---

## Workflow

### Step 1 — Confirm target and screening criteria
Acknowledge the target. Capture or propose screening criteria:
- Sub-sector or business model focus
- Geography (US-listed only / global / regional)
- Size band (market cap or revenue range)
- Profitability filter (positive EBITDA / cash-flow positive / etc.)
- Listing recency (exclude IPOs in last 12 months unless the user specifies)

**Stop and confirm with the user** that these criteria reflect the comp universe they want.

### Step 2 — Build peer set (delegate to `market-researcher`)
Hand the criteria to `market-researcher`. It returns 5–8 candidates with size, geography, and one-line basis for each. **Stop and confirm** the peer set with the user before pulling metrics.

### Step 3 — Pull operating metrics per peer (delegate to `filings-explorer` × N)
For each peer, pull:
- Revenue (LTM)
- Gross margin (LTM)
- EBITDA + EBITDA margin (LTM)
- EBIT + EBIT margin (LTM)
- Net income + EPS (LTM)
- Revenue growth (LTM YoY and 3Y CAGR)
- Free cash flow (LTM)

For projections (NTM, FY+1, FY+2):
- Use FactSet / Bloomberg consensus if configured; otherwise use management guidance from latest call. **Mix is not allowed** — be consistent: every peer's NTM uses the same source type.

### Step 4 — Pull valuation multiples
Per peer, calculate or pull:
- **EV/Revenue** (LTM and NTM)
- **EV/EBITDA** (LTM and NTM) — primary multiple for most sectors
- **P/E** (LTM and NTM) — clean comparable for stable, profitable businesses
- **P/Book** — banks, insurance, asset-heavy
- **EV/EBIT** — when D&A varies materially across peers

EV calculation: `Market Cap + Total Debt − Cash & Equivalents + Minority Interest + Preferred Equity − Investments in Affiliates`. Source the latest BS items from each peer's 10-Q.

### Step 5 — Build the peer table
| Company | Ticker | Mkt Cap | EV | Revenue (LTM) | Rev Growth (NTM) | EBITDA Margin (LTM) | EV/EBITDA (LTM) | EV/EBITDA (NTM) | EV/Revenue (NTM) | P/E (NTM) |
|---|---|---|---|---|---|---|---|---|---|---|
| Peer 1 | TICK1 | ... | ... | ... | ... | ... | ... | ... | ... | ... |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

Add three rows at the bottom:
| **Median** | | | | | | | x.x× | x.x× | x.x× | x.x× |
| **25th %ile** | | | | | | | x.x× | x.x× | x.x× | x.x× |
| **75th %ile** | | | | | | | x.x× | x.x× | x.x× | x.x× |

### Step 6 — Apply to target
Pull the target's metrics (revenue, EBITDA, etc.). Multiply by the peer median multiples to get implied EV; bridge to equity (subtract net debt, divide by diluted shares); compare to current price.

```
Implied EV (EV/EBITDA NTM, peer median):
= Target NTM EBITDA × Peer median EV/EBITDA NTM
= $X.XB × Y.Y×
= $Z.ZB

Implied Equity Value = $Z.ZB − Net Debt
Implied Price = Implied Equity / Diluted Shares = $XX.XX
Current Price = $YY.YY [<source>, <date>]
Implied upside/(downside) = ±X.X%
```

Show the same calc for the 25th and 75th percentile to bound the range.

### Step 7 — Cross-check
- Multiples consistent within sector? Outliers identified and flagged?
- Does the target sit at a premium or discount to peers? Why? (Growth / margin / leverage / governance / catalyst). Surface in `Notes`.
- Reconcile to DCF: if `/dcf` was already run, flag the spread. > 25% gap deserves an explanation.

### Step 8 — Generate the workbook via `/xlsx`

Hand off to the `/xlsx` skill. Specify:

- File: `<Sector>_Comps_<YYYYMMDD>.xlsx` (or `<Target>_Comps_<YYYYMMDD>.xlsx` if the parent skill named a single target).
- Sheets (canonical order): `Inputs`, `Assumptions`, `Model` (the peer table itself), `Sensitivity` (target valuation at low / median / high percentiles), `Output` (one-line summary of implied range).
- Named ranges: `Target_Ticker`, `Target_<MetricName>` for each operating metric pulled, plus `Median_<Multiple>`, `P25_<Multiple>`, `P75_<Multiple>` for each multiple included. Apply target value × peer multiples via formulas referencing those names.
- Number formats: multiples as `0.0"x"`, percent margins as `0.0%`, currency in `$#,##0.0,,"M"`.
- Each peer row's metric carries a cell comment with the filing source + retrieval date. Outliers flagged via cell fill (light yellow) and called out in a `Notes` paragraph on the Output sheet.
- The implied-valuation range on the Output sheet is computed from the peer percentile multiples by formula — flexing any peer row updates the range.

If `/xlsx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.xlsx`; do not fall back to an ASCII table.

### Step 9 — Verify before delivering
Run the **Final Output Checklist** below.

---

<correct_patterns>

### Outlier flag in the comps table

```
Peer table excerpt:

| Company  | Ticker | EV/EBITDA (NTM) |
| Peer A   | TICK1  | 14.2×           |
| Peer B   | TICK2  | 12.8×           |
| Peer C   | TICK3  | 13.5×           |
| Peer D   | TICK4  | 28.5× ⚠         |   ← outlier
| Peer E   | TICK5  | 11.9×           |

Notes: Peer D trades at 2× the peer median due to recent positive
trial readout in oncology pipeline; consider excluding from primary
median or running with/without to bound the range.
```

The outlier is flagged in the table AND explained in `Notes`. Don't bury it.

### Statistical summary at the bottom

```
| Median (EV/EBITDA NTM)  | 12.8×  |
| 25th percentile         | 11.4×  |
| 75th percentile         | 14.0×  |

Implied valuation range applied to target (NTM EBITDA = $X.XB):
- 25th: $11.4 × $X.XB = $YY.YB EV → $ZZ.ZZ / share
- Median: $12.8 × $X.XB = $YY.YB EV → $ZZ.ZZ / share
- 75th: $14.0 × $X.XB = $YY.YB EV → $ZZ.ZZ / share
```

Median + IQR bracket the implied range — not a mean point estimate.

### Honest peer-set documentation

```
Peer set basis:

| Peer    | Why included                          | Caveat                              |
| TICK1   | Same end-market, similar size         | More services-heavy mix             |
| TICK2   | Same end-market, similar growth       | Differs on geography (EU > 60%)     |
| TICK3   | Same business model                   | Conglomerate w/ small unrelated tail |
...

Notable exclusions:
- TICKX: too small (mkt cap < $XB threshold)
- TICKY: pre-revenue / pre-profitability — noise
- TICKZ: private — no public multiples
```

Reader can audit peer selection in 30 seconds.

</correct_patterns>

<common_mistakes>

### WRONG: Mixing LTM with NTM

```
| Peer A | EV/EBITDA: 10.2× | ← LTM
| Peer B | EV/EBITDA: 13.1× | ← NTM
```

Don't mix periods. Pick one (or show both as separate columns) and stay consistent.

### WRONG: Mean instead of median

```
Mean EV/EBITDA: 18.4×   ← dragged up by one 28× outlier
```

Use median; show 25th and 75th. Mean misleads when the distribution is skewed (which it almost always is in comps).

### WRONG: SIC-code "comps" that aren't operationally comparable

```
"Software" peer set:
- Microsoft (cloud / productivity / gaming / hardware)
- Adobe (creative SaaS, mostly recurring)
- Salesforce (CRM SaaS)
- Oracle (database / ERP / cloud / consulting)
- Snowflake (data cloud, hyper-growth pre-profitability)
```

These are all "software," but their growth, margin, and capital-intensity profiles span an order of magnitude. Build a sub-segment peer set, not the SIC bucket.

### WRONG: Stripping the source dates on multiples

```
| Peer A | EV/EBITDA: 12.5× |   ← when?
```

Multiples drift daily. Every multiple cites a date — `[FactSet, 2026-05-06 close]` or `[<source>, <date>]`. Reproducibility matters.

### WRONG: Reaching for size

```
Target market cap: $5B
Peer A: $80B
Peer B: $50B
Peer C: $0.4B
```

Peers should sit within roughly half-to-double the target's size on the relevant metric (mkt cap or revenue). Anything outside is noise.

### TOP 5 ERRORS

1. Mixing LTM with NTM across peers
2. Using mean instead of median (skew bias)
3. Selecting peers by SIC code instead of business-model match
4. Multiples without source dates
5. Peer set spanning > 4× size band (signal/noise too low)

</common_mistakes>

---

## Quality Rubric

Every comps analysis must maximise for:

1. **Operationally comparable peer set** — same business model, similar size, similar growth/margin profile.
2. **Consistent metric definitions** across the table (LTM vs NTM, GAAP vs non-GAAP, currency).
3. **Statistical summary** — median + 25th/75th, not mean.
4. **Outlier transparency** — flagged in the table AND explained in `Notes`.
5. **Implied range applied to target** — three valuation points (25th / median / 75th), not a point estimate.
6. **Cross-check** — premium/discount to peers explained; consistency with DCF if already built.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Sector>_Comps_<YYYYMMDD>.xlsx` (or the parent's specified name).
- [ ] Implied-valuation range on Output sheet is formula-driven against peer percentiles — flexing any peer row updates the range.
- [ ] 5–8 peers, each with documented inclusion basis.
- [ ] Same metric definitions across the table (LTM, NTM, GAAP / non-GAAP, currency normalised).
- [ ] Median + 25th + 75th percentile rows at the bottom of the table.
- [ ] Each multiple cites its source and date.
- [ ] Outliers flagged in the table and explained in `Notes`.
- [ ] Implied valuation applied at all three percentile levels (range, not point).
- [ ] Premium/discount of target vs peer median explained.
- [ ] No investment advice. Implied range stated; the user decides.
