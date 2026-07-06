---
name: earnings
description: Build a quarterly post-earnings recap — headline beat/miss vs consensus, vs-consensus table, guidance change, KPI trajectory, three call quotes. Use when the user asks for an earnings recap, post-earnings note, "what happened with the print," or earnings analysis on a specific quarter. Do not use this for pre-earnings — that's `/earnings-preview`.
trigger: /earnings
---

# Earnings — Quarterly Post-Earnings Recap

## Overview

A one-screen recap of a quarterly print: what was reported, how it compared to consensus, what the company changed about guidance, where KPIs trended, and the three quotes from the call that mattered. Reader gets the picture in under a minute and can dig into any block.

---

## Critical Constraints — read these first, every time

1. **Cite every number.** Press release: `[<Company> <Period> PR, <YYYY-MM-DD>]`. Transcript: `[<Period> call transcript, MM:SS]`.
2. **Beat / miss vs consensus, not just YoY.** If consensus isn't available (no FactSet / Bloomberg), say so explicitly and report YoY only — don't fabricate consensus.
3. **Three quotes maximum.** Surprise driver > guidance > KPI / strategy, in that order. Verbatim. Attribute to the speaker.
4. **Guidance change is a delta, not a level.** Compare new guide to prior guide; report the change (raised / lowered / reiterated / withdrawn) AND the new range.
5. **No "good print" / "bad print" / "in-line" labels.** State the facts; the reader judges.
6. **One quarter per recap.** If the user wants two quarters or a full-year roll-up, that's two calls.
7. **Verify with the user once** — after pulling the press release and consensus, confirm period and consensus source before writing the recap.

---

## Workflow

### Step 1 — Confirm the print
Acknowledge target + period (e.g., `Q1 FY26` for `<Company>`). If the user gave a ticker only, ask which period. Do not guess — wrong period is worse than no answer.

### Step 2 — Pull the press release (delegate to `earnings-reviewer` or `filings-explorer`)
Get the headline numbers: revenue, EPS, EBITDA / operating income, gross margin, segment revenue if material, CFFO if disclosed.

### Step 3 — Pull consensus
- FactSet / Bloomberg consensus if configured.
- Otherwise: most recent earnings preview from a covering broker, or pre-print management guide as the closest reference. **Flag clearly which source was used.**
- **If neither is available:** report YoY-only and surface the gap in `Notes`.

### Step 4 — Pull the call transcript
Identify the three highest-signal quotes. Order: surprise driver → guidance → KPI / strategy. Verbatim, with timestamp and speaker.

### Step 5 — Pull guidance language
- What the company guided previously (last quarter's call, or last update).
- What they're guiding now.
- The delta — raised / lowered / reiterated / withdrawn — per metric they guide.

### Step 6 — Pull the KPI(s) the company reports
ARR, NRR, ARPU, GMV, RPK, same-store sales, occupancy, etc. Latest value + YoY + QoQ delta. Cited.

### Step 7 — Verify before writing
Confirm with the user: period correct, consensus source acceptable, KPIs picked up. Then assemble the recap.

### Step 8 — Build the recap
Use the five-section structure (see *Output shape*). Lead with headline. Tables for vs-consensus and KPI rows.

### Step 9 — Run the **Final Output Checklist**

---

<correct_patterns>

### Headline block

```
## Apple (AAPL) — Q1 FY26 Earnings Recap

Source: <press-release URL>
Reported: 2026-04-23 post-market

### Headline
- Revenue: $94.9B (consensus $93.8B, +1.2%) [AAPL Q1 FY26 PR, p. 2]
- EPS: $2.45 (consensus $2.38, +2.9%) [AAPL Q1 FY26 PR, p. 2]
- Services revenue: $24.2B (+11% YoY) [AAPL Q1 FY26 PR, p. 5]
- Gross margin: 46.6% (consensus 46.0%, +60bp) [AAPL Q1 FY26 PR, p. 3]
```

Headline carries the four numbers a portfolio manager wants in 5 seconds: revenue, EPS, top-of-mind segment, gross margin. Each cited.

### Vs-consensus table

```
| Metric              | Consensus  | Actual  | Surprise  | YoY    |
|---------------------|------------|---------|-----------|--------|
| Revenue ($B)        | 93.8       | 94.9    | +1.2%     | +5.4%  |
| Gross margin (%)    | 46.0%      | 46.6%   | +60bp     | +80bp  |
| Operating income    | 28.4       | 29.1    | +2.5%     | +7.2%  |
| Diluted EPS ($)     | 2.38       | 2.45    | +2.9%     | +6.1%  |

Source: consensus from [FactSet, 2026-04-22 close]; actuals from [AAPL Q1 FY26 PR, p. 2-3]
```

Reader audits beat/miss in one row. Source line tells reader where consensus came from.

### Three-quote section

```
### Three quotes

1. **Surprise driver:** "iPhone revenue was up 8% in constant currency, driven by record demand for the Pro and Pro Max lines, particularly in emerging markets where we saw 22% growth." — Tim Cook [Q1 FY26 transcript, 8:42]

2. **Guidance:** "For Q2 we expect revenue to grow low-single-digits year over year, with services growth in the low double digits and a sequential gross margin in the range of 46.0% to 47.0%." — Luca Maestri [Q1 FY26 transcript, 14:18]

3. **KPI / strategy:** "Our installed base of active devices reached an all-time high across all major product categories, surpassing 2.4 billion devices, and our paid subscription count reached over 1 billion." — Tim Cook [Q1 FY26 transcript, 6:55]
```

Verbatim. Speaker attribution. Timestamp. No paraphrasing.

</correct_patterns>

<common_mistakes>

### WRONG: "Strong print" / "weak quarter" / "in-line"

```
"AAPL delivered a strong quarter, with revenue beating expectations..."
```

State the facts. "Revenue $94.9B (consensus $93.8B, +1.2%)" — the reader judges whether that's strong.

### WRONG: Paraphrasing the call

```
"Tim Cook said iPhone demand was strong in emerging markets."
```

Quote it. Verbatim, with timestamp and speaker. Paraphrasing strips the texture and the audit trail.

### WRONG: Fabricated consensus

```
| Metric  | Consensus | Actual | ... |
| Revenue | 93.5      | 94.9   | ... |   ← invented
```

If consensus isn't sourceable, report YoY-only and flag the gap. Don't make up the consensus number.

### WRONG: Guidance level instead of delta

```
"Guidance: revenue $98-100B for Q2"
```

That's a level. The delta is what matters: "Q2 revenue guide: $98-100B (prior: $96-99B); raised by ~$2B at the midpoint." Report the change, not just the new range.

### WRONG: Mixing periods

```
## AAPL — Q1 FY26 / Q4 FY25 Combined Recap
```

One quarter per recap. Combining periods buries the print.

### TOP 5 ERRORS

1. Editorialising ("strong print," "in-line") instead of stating facts
2. Paraphrasing call quotes (loss of audit trail)
3. Fabricating consensus when it's unavailable (should report YoY-only with gap flag)
4. Reporting guidance level instead of guidance delta vs prior
5. Combining multiple periods in one recap

</common_mistakes>

---

## Quality Rubric

Every earnings recap must maximise for:

1. **Accurate beat/miss vs consensus** with source clearly cited.
2. **Verbatim call quotes** — three, ordered by signal (surprise → guidance → KPI).
3. **Guidance delta** — raised/lowered/reiterated by metric.
4. **KPI trajectory** — latest + YoY + QoQ.
5. **Citation discipline** — every number traces.
6. **No editorialising** — no "good/bad/in-line" labels.

---

## Final Output Checklist

- [ ] Period and ticker confirmed up top.
- [ ] Headline block with 3-5 numbers, each cited.
- [ ] Vs-consensus table — consensus, actual, surprise, YoY.
- [ ] Consensus source named (or YoY-only with gap flagged).
- [ ] Guidance section reports the delta (raised / lowered / reiterated) per metric.
- [ ] KPI trajectory table with latest + YoY + QoQ.
- [ ] Three call quotes — verbatim, with speaker + timestamp.
- [ ] No editorial labels ("strong," "weak," "in-line").
- [ ] No advice. Reader judges; you report.
