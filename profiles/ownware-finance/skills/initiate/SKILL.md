---
name: initiate
description: Build an initiating coverage report — a long-form research note that frames the investment thesis, key risks, near-term catalysts, valuation, and a price-target range. Use when the user asks to initiate coverage, write an initiating note, build a thesis on a new name, or kick off coverage. Output is structured for institutional research distribution.
trigger: /initiate
---

# Initiate — Initiating Coverage

## Overview

A complete first-take research note: the company, the thesis, the risks, the catalysts, the valuation. Designed to be the document an analyst sends to the desk on Day 1 of coverage. Reader walks away knowing what the analyst thinks the company is worth, why, and what would change the view.

---

## Critical Constraints — read these first, every time

1. **The thesis is falsifiable.** If you can't say "I'd be wrong if X happened," it's not a thesis — it's a description.
2. **Every claim sourced.** Filings, transcripts, market data, channel checks — all carry citations.
3. **Risks come in pairs.** For each risk, what's the mitigant or signal that the risk is materialising? Risks-without-monitoring are just hand-waving.
4. **Valuation triangulates.** DCF + comps + (precedents or sum-of-parts when applicable). Single-method valuation is incomplete.
5. **Price target is a range, not a point.** Low (Bear / 25th-percentile valuation), Base (median), High (Bull / 75th).
6. **No "buy / sell / hold."** State the implied range vs current price; the user / committee assigns the rating.
7. **Verify with the user at three checkpoints** — thesis bullets → risks → valuation — before assembling the full note.

---

## Workflow

### Step 1 — Confirm scope
Target + sub-sector + analytical horizon (default 12-month price target, sometimes 6 or 24 depending on the desk).

### Step 2 — Pull the foundation (delegate to `filings-explorer`)
- 3-year P&L, BS, CF
- Latest 10-K business description
- Risk factors (10-K Item 1A)
- Recent 8-Ks for material events
- Latest proxy for executive comp + governance

### Step 3 — Pull peer landscape (delegate to `market-researcher`)
Sub-sector peer set, market structure, recent deals, emerging themes.

### Step 4 — Build investment thesis (3–5 bullets)
Each bullet:
- A claim about the business
- Why it's true (with citation or evidence)
- Why the market may be mispricing it (the alpha case)

**Stop and confirm the thesis with the user** before risking analytical effort on the rest.

### Step 5 — Risks (3–5)
Each risk:
- The risk itself
- The probability assessment (Low / Medium / High — qualitative, with reasoning)
- The signal: what data point tells you it's materialising
- The mitigant or company response

**Stop and confirm risks** before valuation.

### Step 6 — Catalysts (next 12 months)
Time-tagged: scheduled (earnings dates, investor days, regulatory milestones) and probable (capacity additions, product launches).

### Step 7 — Valuation
- **DCF** (call `/dcf`) — Bear / Base / Bull cases
- **Comps** (call `/comps`) — peer median + 25th/75th
- (**Precedents** if M&A relevant — sub-set of `/comps` discipline)
- **SOTP** if multi-segment

**Stop and confirm valuation methodology and inputs** before settling on the price target.

### Step 8 — Price target range
- Low = Bear DCF or 25th-percentile comps
- Base = Base DCF or median comps (median of methods)
- High = Bull DCF or 75th-percentile comps
- Implied upside / downside vs current price for each level

### Step 9 — Build the structured note
Draft the section content per the template in *Output shape*. Every section sourced.

### Step 10 — Generate the file via `/docx`

Hand off to `/docx`. An initiation note is a formal published document, not a chat reply. Specify:

- File: `<Ticker>_Initiation_<YYYYMMDD>.docx`.
- Cover: Ticker / company name, "Initiation of Coverage," date, version, analyst / desk / firm.
- TOC field after the cover.
- Heading discipline: H1 per section (Recommendation, Thesis, Risks, Catalysts, Valuation, Price Target, Financials, Governance), H2 below. Built-in styles only.
- Recommendation block at the very top of the body — rating + price target + horizon — bolded so the reader can read page 1 alone and know the call.
- Tables for the price-target methodology (DCF / comps / scenarios) use `Light Grid Accent 1`; numeric columns right-aligned.
- Header on body pages: `<Ticker> — Initiation of Coverage`; footer: `Page X of Y`.
- Disclaimer page at the end (firm-specific compliance language; surface to user if not provided).

If `/docx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.docx`; published research is not a chat message.

### Step 11 — Run **Final Output Checklist**

---

<correct_patterns>

### Falsifiable thesis bullet

```
**Thesis 2 of 4: Services mix shift to 30%+ of revenue by FY28**
- Services revenue grew 14% YoY in FY24 vs hardware +2% [10-K FY24, p. 32]
- Installed base of 2.4B+ active devices generates services attach rate currently 14% [Q1 FY26 call, 6:55]
- We'd be WRONG if: (a) hardware revenue accelerates above 8% YoY for two consecutive quarters, or (b) services growth decelerates below 8% YoY.
- Why the market may be mispricing: street models 22% services mix in FY28; we model 31%, implying ~$25B of incremental services revenue [our model, see Valuation section].
```

The bullet has a claim, evidence, falsification criteria, and the mispricing case. Reader can audit each piece.

### Risks-with-monitoring

```
| # | Risk                                         | Probability  | Signal                                      | Mitigant / Company response             |
|---|----------------------------------------------|--------------|---------------------------------------------|------------------------------------------|
| 1 | China unit volume decline > 15% YoY          | Medium       | Monthly retail registration data; channel surveys | Ramp of India + emerging-market platforms |
| 2 | Services attach rate plateaus at < 18%       | Low          | Quarterly services-revenue YoY < 10%        | New services launches; bundling          |
| 3 | EU DMA forces App Store fee structural cut   | Medium       | EC enforcement actions; competitor app stores | Legal challenges; alternative monetisation |
| 4 | Component cost inflation > expected          | Low          | TSMC / DRAM pricing trend                    | Long-term supply agreements; pricing       |
```

Each risk has a probability, a signal to monitor, and a mitigant. Not just a list of bad things that could happen.

### Valuation triangulation

```
### Valuation summary

| Method               | Low ($)  | Base ($) | High ($) | Notes                                           |
|----------------------|----------|----------|----------|-------------------------------------------------|
| DCF                  | $185     | $215     | $255     | WACC 9.0%, terminal g 3.0%, Bear/Base/Bull       |
| Comps (EV/EBITDA NTM)| $192     | $218     | $245     | 14.2× peer median (25th/75th: 12.8x/15.6x)       |
| Comps (P/E NTM)      | $188     | $212     | $238     | 28× peer median                                  |
| Precedent transactions | n/a    | n/a      | n/a      | No directly comparable take-privates             |

### Price target range
- Low: $185 (-X% vs current $YYY)
- Base: $215 (+X% vs current)
- High: $245 (+X% vs current)

Source for current price: [FactSet, 2026-05-06 close]
```

Three methods, range from each, blended into a single PT range. Reader can audit which method drives the answer.

</correct_patterns>

<common_mistakes>

### WRONG: Description as thesis

```
"Apple is a leader in consumer electronics with strong brand equity."
```

That's a description, not a thesis. A thesis is "the market is mispricing X because Y." Falsifiable.

### WRONG: Risk list without monitoring

```
"Risks: China demand, regulatory, supply chain, cyclicality."
```

Bare risk list. No probability, no signal, no response. Add the structure.

### WRONG: Single-method valuation

```
"DCF implies $215. PT = $215."
```

DCF alone isn't enough. Triangulate against comps (and precedents if M&A relevant). A 25%+ gap between methods deserves an explanation, not omission.

### WRONG: Point price target

```
"PT: $215."
```

Point estimates pretend precision. Range: Low / Base / High, each tied to a method.

### WRONG: "Buy / Sell / Hold" rating in the note

```
"Initiating with a Buy rating, PT $215."
```

State the implied upside/downside. The desk / PM assigns the rating; the analyst frames the work.

### TOP 5 ERRORS

1. Description-style "thesis" that isn't falsifiable
2. Bare risk list without probability + signal + mitigant
3. Single-method valuation (DCF only or comps only)
4. Point price target instead of range
5. Embedding a Buy/Sell/Hold rating

</common_mistakes>

---

## Quality Rubric

Every initiating coverage note must maximise for:

1. **Falsifiable thesis** — 3–5 bullets, each with a "we'd be wrong if X" criterion.
2. **Risks with monitoring** — probability, signal, mitigant.
3. **Catalysts time-tagged** — scheduled vs probable, with dates.
4. **Triangulated valuation** — DCF + comps minimum.
5. **Price target as a range** — Low / Base / High, each tied to a method.
6. **No rating** — implied upside stated; the user / committee decides.

---

## Final Output Checklist

- [ ] `.docx` file generated via `/docx` and saved at the expected path. File name matches `<Ticker>_Initiation_<YYYYMMDD>.docx`.
- [ ] Recommendation block (rating + price target + horizon) is bolded at the top of page 1; reader can read page 1 alone and know the call.
- [ ] Foundation pulled (filings, peer landscape, governance).
- [ ] 3–5 thesis bullets, each falsifiable, each cited.
- [ ] 3–5 risks, each with probability + signal + mitigant.
- [ ] Catalyst calendar with scheduled and probable dates.
- [ ] DCF complete (Bear / Base / Bull).
- [ ] Comps complete (peer median + 25th/75th).
- [ ] Precedents or SOTP if relevant.
- [ ] Price target range — Low / Base / High — derived from methods, not invented.
- [ ] Implied upside vs current cited price.
- [ ] No "Buy / Sell / Hold" rating.
- [ ] No fabricated peers or numbers.
