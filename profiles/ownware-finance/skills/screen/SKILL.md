---
name: screen
description: Build an idea screen — filter a universe by a thesis-aligned set of constraints, return a ranked shortlist with metrics. Use when the user asks for a screen, idea generation, "find me names with X," or wants to systematically search for opportunities matching a thesis. Distinct from sector overview (`/sector`) — a screen produces names, not landscape.
trigger: /screen
---

# Screen — Idea Generation

## Overview

A systematic filter: start with a universe, apply constraints sequentially, end with a ranked shortlist. The output answers "given this thesis or these constraints, what names show up." Designed to be reproducible — anyone re-running the same screen on the same date should get the same list.

---

## Critical Constraints — read these first, every time

1. **The thesis comes first.** No "find me cheap stocks." A screen is `<thesis>` filtered through `<constraints>`. If the user gives constraints without a thesis, ask for the thesis or extract it.
2. **Constraints applied in order, with cardinality at each step.** "Started 4,200 names, applied size filter → 950, applied profitability → 410, applied valuation → 78, applied insider buying → 12." Reader can audit the funnel.
3. **Universe explicit.** S&P 500 ≠ Russell 2000 ≠ Russell 3000 ≠ All US-listed. Name the universe and source it.
4. **Each filter cites its source.** Multiples from FactSet (or fallback). Insider buying from Form 4 (SEC). Profitability from latest 10-Q.
5. **No fabricated names.** If you can't verify a name passes all filters with citations, exclude it.
6. **No "best ideas" / "favourites" / "buy" labels.** State the ranked list with the rank metric explicit; the user / PM picks names from it.
7. **Surface what the screen would miss.** Foreign listings, private comps, recent IPOs, names below the size threshold — flag the exclusions.

---

## Workflow

### Step 1 — Confirm thesis
What hypothesis is the screen testing? Examples:
- "Quality compounders with insider buying" — implies high ROIC, FCF margin, low leverage, recent insider purchases
- "Beneficiaries of Capex cycle" — implies industrial / capital goods exposure, backlog growth, margin expansion
- "Net-cash microcaps with founder ownership" — implies size cap, balance-sheet filter, ownership disclosure

If the thesis is unclear, **ask** before screening.

### Step 2 — Set the universe
Default options:
- **S&P 500** — large-cap US
- **Russell 1000 / 2000 / 3000** — broad-cap US
- **All US-listed with mkt cap > $X** — custom size
- **Sector-specific** (e.g., "US software with mkt cap > $1B")

Source the universe (which index, which date, which provider).

### Step 3 — Define constraints (in priority order)
Write them down before applying any. Priority order matters because intermediate cardinality determines what's left for finer filters.

Example for "Quality compounders":
1. Size: mkt cap > $1B (filters out micro-caps)
2. Profitability: positive EBITDA last 4 quarters
3. Quality: ROIC > 15% (5-year average)
4. Cash generation: FCF margin > 10% (3-year average)
5. Leverage: Net debt / EBITDA < 2.0×
6. Valuation: NTM EV/EBITDA < 25× (peer-relative)
7. Insider activity: net insider buying > $1mm in last quarter

### Step 4 — Apply constraints sequentially
For each filter, report:
- Filter description
- Source
- Cardinality (count) before AND after

```
Step 1 (Size): 4,200 names → 950 names
Step 2 (Profitability): 950 → 410
...
```

### Step 5 — Final ranked list
Pick a rank metric tied to the thesis. For "quality compounders": ROIC × FCF margin / NTM EV/EBITDA. Sort and report the top 10–20.

For each name in the final list:
- Ticker, name, sector
- Each filter metric value
- Source for each value

### Step 6 — Surface limits
- Universe excluded: foreign-listed, ADRs, recent IPOs, micro-caps, etc.
- Data gaps: companies missing one filter were excluded — surface how many.
- Where paid-feed data would tighten the screen.

### Step 7 — Generate the workbook via `/xlsx`

Hand off to `/xlsx`. The screen result is fundamentally a tabular dataset — perfect for a workbook the analyst can re-sort, re-filter, and roll forward. Specify:

- File: `<Thesis_or_Theme>_Screen_<YYYYMMDD>.xlsx` (e.g. `Industrials_FCF_Screen_20260507.xlsx`).
- Sheets: `Inputs` (thesis statement + universe + constraint priority), `Funnel` (cardinality before / after each step + source), `Shortlist` (final ranked list with every filter metric per name + source columns), `Limits` (universe exclusions + data gaps + where paid-feed data would tighten), `Output` (one-line summary: shortlist count + median multiples + breakdown by sub-sector).
- Named ranges: each constraint threshold gets a name (`Min_Revenue_Growth`, `Max_Net_Debt_EBITDA`, `Min_FCF_Margin`, etc.) so flexing a threshold on `Inputs` re-applies the screen if the analyst chooses to re-run.
- Shortlist columns: Ticker, Name, Sector, Market Cap, then one column per filter metric, then one Source column per metric (citation + date), then a Notes column for analyst commentary.
- Conditional formatting: each filter-metric column highlights green when the value passes the constraint by ≥20% margin, yellow when within 20% of the threshold (close calls worth re-checking).
- Funnel sheet shows the conventional cardinality drop-off chart (built as inline Excel chart referencing the Funnel-sheet cells).

If `/xlsx` reports a missing-Python error, surface its install instruction and stop.

### Step 8 — Run **Final Output Checklist**

---

<correct_patterns>

### Constraint funnel

```
### Funnel

Universe: Russell 1000 as of 2026-05-01 [FactSet, 1,012 names]

| Step | Filter                                          | Cardinality | Source                                |
|------|-------------------------------------------------|-------------|---------------------------------------|
| 1    | Mkt cap > $1B                                   | 1,012 → 968 | [FactSet, 2026-05-06 close]            |
| 2    | Positive EBITDA last 4Q                         | 968 → 624   | [10-Q rollups, FactSet]                |
| 3    | ROIC > 15% (5-year average)                     | 624 → 187   | [calculated from 10-K segment data]    |
| 4    | FCF margin > 10% (3-year average)               | 187 → 122   | [10-K cash flow]                       |
| 5    | Net debt / EBITDA < 2.0×                        | 122 → 84    | [latest 10-Q balance sheet]            |
| 6    | NTM EV/EBITDA < 25×                             | 84 → 41     | [FactSet consensus]                    |
| 7    | Insider buying > $1mm last quarter (net)        | 41 → 14     | [SEC Form 4 aggregations]              |

Final shortlist: 14 names
```

The reader sees how the universe shrunk at each step. If they distrust step 3, they know exactly how to relax it.

### Ranked shortlist with metrics

```
### Final shortlist (top 14, ranked by ROIC × FCF margin / NTM EV/EBITDA)

| Rank | Ticker | Sector       | Mkt Cap ($B) | ROIC (5Y) | FCF Margin (3Y) | Net Debt / EBITDA | NTM EV/EBITDA | Insider $ (Q) |
|------|--------|--------------|--------------|-----------|-----------------|-------------------|----------------|---------------|
| 1    | XYZ    | Industrials  | 4.2          | 22%       | 17%             | 0.8×              | 14×            | $4.2mm         |
| 2    | ABC    | Software     | 8.1          | 28%       | 22%             | 0.0× (net cash)   | 18×            | $2.1mm         |
| ...  | ...    | ...          | ...          | ...       | ...             | ...               | ...            | ...            |

Sources: ROIC + FCF margin from 10-K/10-Q rollups; multiples from [FactSet, 2026-05-06 close]; insider $ from [Form 4 aggregations, Q1 2026].
```

Every name has every metric displayed. Ranks are deterministic given the metric.

### Exclusions surfaced

```
### What the screen excludes

- **Foreign-listed (ADRs):** 84 names removed at universe step (Russell 1000 US-listed only).
- **Pre-revenue / pre-profitability:** ~340 names removed at profitability step.
- **Recent IPOs (< 12 months):** 12 names removed (insufficient 5-year history).
- **Private competitors:** not in scope.
- **Where paid-feed data would tighten:** consensus EV/EBITDA NTM uses FactSet; without it, EV/EBITDA is computed from 10-K + last close which lags by 1-2 quarters.
```

Reader knows what's NOT in the shortlist and why.

</correct_patterns>

<common_mistakes>

### WRONG: No thesis, just filters

```
"Find me names with low EV/EBITDA and high ROE."
```

That's not a thesis — it's a filter. Frame: "Quality compounders trading at peer-relative discount" → constraints: low EV/EBITDA + high ROE + high FCF + low leverage.

### WRONG: Cardinality not reported

```
"After applying filters, here are the 14 names: ..."
```

Reader can't audit. Show the funnel: 1,012 → 968 → 624 → ... → 14.

### WRONG: Universe undefined

```
"Screened US stocks for ..."
```

Which universe? S&P 500? Russell 1000? All listed? Cite the universe name + the source.

### WRONG: "Best ideas" framing

```
"Our top 5 best ideas from the screen:"
```

The screen doesn't know which are "best." It produces a ranked list per the rank metric. The PM picks favourites.

### WRONG: Hidden data gaps

```
"14 names made the final cut."
```

Were there 8 names dropped at step 5 because consensus data was missing? Surface that. "14 names final; 8 names had incomplete consensus and were excluded."

### TOP 5 ERRORS

1. Filters without an underlying thesis
2. Cardinality not reported (funnel hidden)
3. Universe undefined or unsourced
4. "Best ideas" / "favourites" framing instead of ranked-by-metric
5. Data-gap exclusions hidden in the result

</common_mistakes>

---

## Quality Rubric

Every screen must maximise for:

1. **Thesis-driven** — the constraints reflect a specific hypothesis.
2. **Reproducible** — universe, source, and date all explicit.
3. **Funnel transparency** — cardinality at each step.
4. **Sourced metrics** — every filter cites its data source.
5. **Ranked, not curated** — order is deterministic per the rank metric.
6. **Exclusions surfaced** — what the screen would miss.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Thesis_or_Theme>_Screen_<YYYYMMDD>.xlsx`.
- [ ] Constraint thresholds are named ranges; flexing a threshold on `Inputs` re-applies the screen.
- [ ] Thesis stated up top.
- [ ] Universe named, sourced, dated.
- [ ] Constraints listed in priority order before being applied.
- [ ] Funnel table — cardinality before / after each step, with source.
- [ ] Final shortlist with all filter metrics displayed per name.
- [ ] Rank metric explicit and consistent.
- [ ] Exclusions section surfaces foreign / private / recent-IPO / data-gap drops.
- [ ] No "best ideas" / "favourites" / "buy" framing.
- [ ] No fabricated names — every shortlist row's metrics are sourceable.
