---
name: earnings-preview
description: Build a pre-earnings preview — what to watch, scenario table (beat / in-line / miss), KPIs to track, read-throughs from peers and supply chain. Use when the user asks for an earnings preview, pre-print analysis, "what to look for in the upcoming print," or wants to set expectations before a company reports. Do not use post-print — that's `/earnings`.
trigger: /earnings-preview
---

# Earnings Preview

## Overview

A pre-print briefing that frames what the market expects, what management has guided, what KPIs to track, and what scenarios drive the outcome. The reader walks into the print knowing what to look for, what would surprise, and what wouldn't.

---

## Critical Constraints — read these first, every time

1. **Forecast vs fact, always.** Everything you write before the company reports is an estimate or scenario, never a stated fact. Use `Forecast:`, `Scenario:`, or `Expected:` labels. No fact-tense for unreported numbers.
2. **Cite every consensus and historical reference.** Same discipline as `/earnings`.
3. **Three scenarios — Beat / In-line / Miss.** Not five, not one. Each scenario specifies a range, not a point.
4. **KPIs to watch are pre-committed by management.** If the company guides ARR, list ARR. Don't import KPIs the company doesn't report.
5. **Read-throughs are sourced.** Peer quote, supply-chain data point, regulatory event — each cited with a date.
6. **No predictions of stock direction.** "If they beat, the stock will rip" — no. State what each scenario implies for guidance / margins / multiple, not for the share price.

---

## Workflow

### Step 1 — Confirm scope
Target + reporting date (next scheduled print). If date is unknown, ask the user or pull from the IR calendar.

### Step 2 — Pull the last 4 quarters (delegate to `filings-explorer`)
Recent margin trajectory, KPI levels, segment performance, leverage trend.

### Step 3 — Pull current consensus
- Revenue, EPS, EBITDA, segment revenue (each with consensus + range high/low).
- If consensus unavailable: flag and use most-recent management guide as the reference.

### Step 4 — Pull last guidance
The guide management gave on the prior call (and any updates since via 8-K or pre-announcement).

### Step 5 — Pull peer / supply-chain read-throughs (delegate to `market-researcher`)
- Recent peer earnings calls (same-quarter prints from competitors).
- Supply-chain commentary (suppliers, customers, partners).
- Channel checks if available (foot traffic, downloads, ad spend).
- Macro datapoints relevant to the company (rate cuts, FX, commodity).

### Step 6 — Build the scenario table
For each KPI (revenue, gross margin, operating income, EPS):

| KPI | Miss range | In-line range | Beat range | What it implies |
|---|---|---|---|---|
| Revenue ($B) | < $X | $X–$Y | > $Y | Beat: demand stronger than guide |
| Gross margin (%) | < X% | X%–Y% | > Y% | Beat: pricing power / mix shift / cost-out |
| EPS ($) | < $X | $X–$Y | > $Y | Beat: top-line + margin combo |

### Step 7 — KPIs to watch (sub-headline metrics)
Per the company's own guidance pattern. Each with prior trajectory + the level that would surprise.

### Step 8 — Read-throughs section
Bullet list. Each bullet: data point + source + date + read-through implication.

### Step 9 — Risk to thesis
What would change the read on the company beyond Q-end (regulatory action, customer concentration disclosure, cohort data).

### Step 10 — Final Output Checklist

---

<correct_patterns>

### Forecast labelling

```
Forecast: Q1 revenue $93B-$95B (consensus $93.8B [FactSet, 2026-04-22]; mgmt guide
$92-$96B [Q4 FY25 call, 14:18]). Mix between guidance and consensus based on
peer-print read-through (TSMC reported 12% YoY in foundry, suggesting iPhone build
volume was at the high end of company plan).
```

Every forward-looking number labelled `Forecast:` or scenario-tagged. Inputs cited.

### Scenario table

```
| KPI                  | Miss        | In-line     | Beat        | Read-through |
|----------------------|-------------|-------------|-------------|--------------|
| Revenue ($B)         | < 92.0      | 92.0–94.5   | > 94.5      | Beat = ASP up + units holding; in-line = mix shift; miss = China demand |
| Gross margin (%)     | < 45.5      | 45.5–46.5   | > 46.5      | Beat implies services mix tipping further |
| Services rev ($B)    | < 23.5      | 23.5–24.2   | > 24.2      | Beat = subscription pricing / installed base monetisation |
| Diluted EPS ($)      | < 2.30      | 2.30–2.45   | > 2.45      | Top-line + GM combo |
```

Each scenario is a range, with the implication the reader cares about — what does each scenario tell us about the underlying business.

### Read-through bullets

```
### Read-throughs

- **TSMC Q1 FY26 result (2026-04-15):** Foundry revenue +12% YoY, 7nm capacity utilisation 95%. Read-through: iPhone build volumes at high end of company plan; supportive of revenue beat. [TSMC Q1 FY26 PR; <URL>]

- **Samsung memory commentary (2026-04-08):** DRAM pricing up 8% sequentially. Read-through: Mac / iPad COGS pressure if Apple sourced at spot vs LTA. [<source URL>, <date>]

- **US 10Y yield trend (2026-04-30):** Rates up 30bp since last call; FX strengthening. Read-through: Services revenue weighted to USD-billed contracts; minor FX tailwind YoY. [FRED DGS10, 2026-04-30]
```

Each read-through is a data point + source + date + the implication for the print. Reader doesn't have to do the inference work.

</correct_patterns>

<common_mistakes>

### WRONG: Stock-direction prediction

```
"If they beat consensus by 3%+, the stock should rally 5-7% on the print."
```

No. State what each scenario implies about the BUSINESS (margins, mix, guide cuts), not what it implies for share price. Stock reactions are out of scope.

### WRONG: Fact-tense forward statements

```
"Revenue grows 8% in Q1 driven by services."
```

Use forecast labelling: `Forecast: revenue +6% to +9% YoY in Q1, with services contributing 3-4pts of the growth.`

### WRONG: Inventing KPIs

```
"Watch for the new AI Compute KPI..."   ← company doesn't report this
```

Don't invent metrics. Only KPIs the company has committed to report. If you think a metric SHOULD be reported, that's a risk-flag, not a KPI to watch.

### WRONG: Read-through without citation

```
"Asian supply chain seems strong this quarter."
```

Vague + uncited. Replace with: "TSMC Q1 FY26 result reported 12% foundry growth on 2026-04-15 [TSMC Q1 FY26 PR]; read-through to iPhone build volumes is supportive."

### WRONG: Single scenario or no ranges

```
"Forecast: Revenue $93.5B."
```

Single point estimates pretend more precision than exists. Use ranges (Beat / In-line / Miss) tied to thresholds.

### TOP 5 ERRORS

1. Predicting stock direction instead of business outcomes
2. Fact-tense for forward statements (drops the forecast label)
3. Inventing KPIs the company doesn't report
4. Uncited read-through bullets
5. Point estimates instead of scenario ranges

</common_mistakes>

---

## Quality Rubric

Every earnings preview must maximise for:

1. **Forecast discipline** — every forward number labelled.
2. **Three scenarios with ranges** — Beat / In-line / Miss thresholds defined.
3. **KPIs to watch** — only ones the company reports.
4. **Read-throughs cited** — peer / supply-chain / macro data points with dates.
5. **Business-outcome framing** — not stock-price prediction.
6. **Risks to thesis** — one bullet on what would change the read regardless of the print.

---

## Final Output Checklist

- [ ] Reporting date confirmed.
- [ ] Last 4Q context summary (margins, KPI trajectory).
- [ ] Consensus pulled and cited (or gap flagged with substitute).
- [ ] Last management guide pulled with timestamp.
- [ ] Scenario table — Miss / In-line / Beat ranges per KPI with implications.
- [ ] KPIs to watch listed (only ones the company reports).
- [ ] Read-throughs section — each bullet with data + source + date + implication.
- [ ] Forecast labelling on every forward number.
- [ ] Risk to thesis bullet.
- [ ] No share-price prediction.
- [ ] No advice / "buy / sell" framing.
