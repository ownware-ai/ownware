---
name: sector
description: Build a sector overview, morning note, or thematic analysis — market structure, top players, recent activity, trends, read-throughs. Use when the user asks for a sector overview, industry deep-dive, morning note, thematic primer, or a roll-up of what's moving in a vertical. Tone scales by length — morning note is tight (1 page), sector overview is comprehensive (3-5 pages), thematic is focused on a specific question.
trigger: /sector
---

# Sector — Sector Overview / Morning Note / Thematic

## Overview

A structured read on a sector or theme: market size and structure, top players, recent activity (deals, capital raises, regulatory), emerging trends, read-throughs to specific names. Reader gets the lay of the land in one document.

---

## Critical Constraints — read these first, every time

1. **Every market-share, market-size, and growth figure dates.** A 2-year-old McKinsey report is stale; cite the date.
2. **No fabricated peers or market shares.** If you can't verify a competitor exists or a market-share number is sourceable, omit and flag.
3. **Match the format to the ask.** Morning note ≠ sector overview ≠ thematic. Length, depth, and what to lead with all differ.
4. **Surface coverage gaps.** Private competitors, foreign-listed names, recent IPOs not in the peer set, micro-caps below threshold — flag what's missing.
5. **No sector recommendations.** "Overweight financials" / "underweight tech" — no. State the data; the strategist / PM makes calls.
6. **Read-throughs cite the connection.** If TSMC's print is read-through to AAPL, cite the supply-chain link.

---

## Workflow

### Step 1 — Confirm scope and format
- **Format:** morning note (1 page, tight) / sector overview (3–5 pages, comprehensive) / thematic (focused on a specific question).
- **Sector / theme:** sub-sector if "sector" is too broad (e.g., "US large-cap software" vs "tech").
- **Geography:** US-listed only / global / regional.
- **Universe filter:** size band, profitability gate, etc.

### Step 2 — Pull market structure (delegate to `market-researcher`)
- Market size + 5-year CAGR
- Top-5 share + concentration trend
- Sub-segments and their dynamics
- Key drivers (with sources)

### Step 3 — Pull recent activity (last 30/60/90 days depending on format)
- M&A: announced and closed deals
- Capital raises: equity, debt, secondary
- Regulatory events: rule-makings, enforcement actions
- Earnings prints from major players (cite each)

### Step 4 — Build the top-players table
Top 5–10 names with:
- Market cap, revenue, growth, margin
- Most recent multiple (cited with date)
- One-line "what they do"

### Step 5 — Trends + read-throughs
3–5 emerging themes. For each:
- The theme (one line)
- Evidence (data points with sources)
- Read-through to specific names (which beneficiary / which loser, with the connection cited)

### Step 6 — Build the document per format
**Morning note:** 1 page max. Top of page = the takeaway. Below = the 3–5 supporting bullets.
**Sector overview:** Cover → market structure → sub-segments → top players → recent activity → trends → outlook → notes.
**Thematic:** the specific question up top → evidence → exposure ranking → risks to thesis → notes.

### Step 7 — Generate the file via `/docx`

Hand off to `/docx`. Sector notes / overviews / thematics are read top-to-bottom and circulated; they belong in Word, not chat. Specify:

- File: `<Sector_or_Theme>_<Format>_<YYYYMMDD>.docx` (e.g. `Industrials_Morning_20260507.docx`, `Cybersecurity_Overview_20260507.docx`, `AI_Capex_Thematic_20260507.docx`).
- Cover (overview + thematic only — morning notes skip the cover and lead with the takeaway): sector / theme name, format label, date, analyst.
- Heading discipline: H1 per top-level section per the chosen format (morning: takeaway → supporting bullets; overview: market structure → sub-segments → top players → recent activity → trends → outlook → notes; thematic: the question → evidence → exposure ranking → risks → notes), H2 below. Built-in styles only.
- Top-players table uses `Light Grid Accent 1`; numeric columns right-aligned; multiples formatted as `0.0x`, percentages as `0.0%`.
- Footer carries page number; header carries the sector / theme name (omitted on morning-note format).
- For overview / thematic formats, append a Sources section at the end — every chart and stat traceable to a citation.

If `/docx` reports a missing-Python error, surface its install instruction and stop. Published research is not a chat message.

### Step 8 — Run **Final Output Checklist**

---

<correct_patterns>

### Morning note format (one page)

```
## US Large-Cap Software — Morning Note, 2026-05-07

### The takeaway
Software multiples re-rated +1.5 turns over the past 30 days as 10Y yields fell 35bp [FRED DGS10, 2026-04-08 vs 2026-05-07] and Q1 prints from CRM, NOW, ADBE all beat on services-driven growth. The largest dispersion within the cohort is between AI-native incumbents (re-rated full multiple turn) and legacy modernisers (re-rated half).

### What moved
- **CRM Q1 FY27 (2026-05-06):** Revenue +9.5% YoY (consensus +8.7%), services attach +14% YoY [<source>]. Stock +4.2% post-print.
- **NOW Q1 FY26 (2026-04-30):** ARR +22% YoY, NRR 119% [<source>]. Stock +6.8% post-print.
- **ADBE Q2 FY26 (2026-04-23):** Revenue +9% YoY (consensus +8%), Firefly billings doubled YoY [<source>]. Stock +3.5% post-print.

### Read-throughs
- **MSFT print 2026-05-09:** GitHub Copilot ARR is the read on AI uptake; consensus is $700mm.
- **GOOGL print 2026-05-15:** Cloud growth ≥ 28% would extend the AI-native re-rate; < 25% drives a partial give-back.

### Risks to the cohort
- Yields back-up: software duration is sensitive; 25bp move = ~70bp impact on multiples [based on rolling 12M correlation; not advice].
- DOJ enforcement on platform monetisation could compress GOOGL/AMZN; secondary impact on adjacent SaaS via switching costs.

[no investment recommendations]
```

Tight, sourced, scannable. The reader sees the takeaway, the data, the connections, the risks — all in one screen.

### Sector overview top-players table

```
### Top players — US Large-Cap Software (NTM EV/EBITDA)

| Company       | Ticker | Mkt Cap ($B) | Revenue ($B, NTM) | Rev Growth (NTM) | EBITDA Margin (NTM) | EV/EBITDA (NTM) | Notes                                |
|---------------|--------|---------------|-------------------|------------------|---------------------|-----------------|--------------------------------------|
| Microsoft     | MSFT   | 3,200         | 290               | +13%             | 49%                 | 26×             | AI capex cycle dominant              |
| Salesforce    | CRM    | 280           | 38                | +9%              | 32%                 | 22×             | services attach driving growth       |
| Adobe         | ADBE   | 220           | 22                | +9%              | 47%                 | 24×             | Firefly drives AI monetisation       |
| ServiceNow    | NOW    | 200           | 11                | +22%             | 40%                 | 32×             | platform compounder; ARR 22%          |
| Workday       | WDAY   | 70            | 8                 | +14%             | 30%                 | 26×             | mid-tier finance/HR consolidation     |

Source: [FactSet, 2026-05-06] for multiples; latest 10-Q for revenue + margins; *or fallback flag if FactSet not configured*

| Median        |        |               |                   |                  |                     | 26×             |                                      |
| 25th %ile     |        |               |                   |                  |                     | 24×             |                                      |
| 75th %ile     |        |               |                   |                  |                     | 28×             |                                      |
```

Same discipline as `/comps` — peer table with statistical summary at the bottom.

### Read-through with the connection cited

```
### Read-through: TSMC Q1 FY26 → Apple Q2 FY26

**TSMC (2026-04-15):** N3 capacity utilisation 95%; foundry revenue +12% YoY.
**Apple supply-chain link:** TSMC produces ~25% of Apple's total chip volume, including A-series and M-series silicon; ramp utilisation typically leads iPhone build volumes by 6-8 weeks [TSMC IR Q3 FY24 disclosure, p. 8; Apple 10-K FY24, p. 11 supplier concentration].
**Read-through:** Suggests iPhone build volumes at the high end of company guide for Q2 FY26; supportive of revenue beat.
```

The connection isn't asserted; it's documented.

</correct_patterns>

<common_mistakes>

### WRONG: Stale market-share figure

```
"The cloud market is growing 17% per year."   ← from a 2023 Gartner report
```

Cite + date + flag if stale: "[Gartner Cloud Forecast, 2025-Q4 update; figure may be stale by Q1 FY27]."

### WRONG: SIC-bucket "sector" that mixes unrelated names

```
"Tech: AAPL, MSFT, NVDA, NFLX, ADBE..."
```

Tech is too broad. Decompose to sub-sectors (consumer electronics / semis / streaming / SaaS) where the cohort dynamics are coherent.

### WRONG: "Overweight" / "Underweight" / "Buy the sector"

```
"We recommend Overweight on Software given AI tailwinds."
```

Don't. State the data; the strategist / PM rates the sector.

### WRONG: Read-through without the link

```
"TSMC up — bullish for Apple."
```

Cite the connection: which products, what % of supply, what's the lead-lag relationship.

### WRONG: Treating a private competitor as if it's listed

```
| Company | Ticker | Mkt Cap | ... |
| OpenAI  | (n/a)  | $300B   | ... |   ← public market cap doesn't exist
```

Private comps go in their own section, with valuation stated as "last round / latest mark," not market cap.

### TOP 5 ERRORS

1. Market-share / size figures without dates (staleness)
2. SIC-bucket sector that mixes unrelated cohorts
3. Sector recommendations (Overweight / Underweight)
4. Read-throughs without the connecting link cited
5. Mixing private competitors with public peer table without separation

</common_mistakes>

---

## Quality Rubric

Every sector / morning / thematic note must maximise for:

1. **Format-appropriate length** — morning note tight, overview comprehensive, thematic focused.
2. **Sourced market structure** — every size / share / growth figure cited and dated.
3. **Peer table with statistical summary** — same discipline as `/comps`.
4. **Recent activity** — deals, raises, regulatory, prints — last 30/60/90 days.
5. **Read-throughs with linkage** — connections cited, not asserted.
6. **No sector rating** — data presented; strategist / PM decides.

---

## Final Output Checklist

- [ ] `.docx` file generated via `/docx` and saved at the expected path. File name matches `<Sector_or_Theme>_<Format>_<YYYYMMDD>.docx`.
- [ ] Heading styles applied (Heading 1 / Heading 2 — not bold paragraphs); top-players table uses `.style`.
- [ ] Format confirmed (morning / overview / thematic).
- [ ] Sector / theme scope is sub-sector-precise (not "tech" or "healthcare" alone).
- [ ] Market structure section with size / CAGR / concentration, all dated.
- [ ] Top-players table with multiples + statistical summary.
- [ ] Recent activity bullets covering M&A / raises / regulatory / prints.
- [ ] Trends + read-throughs section, each with cited linkage.
- [ ] Coverage gaps flagged (private / foreign / micro-cap exclusions).
- [ ] No sector ratings / recommendations.
- [ ] No fabricated peers, market shares, or deal numbers.
