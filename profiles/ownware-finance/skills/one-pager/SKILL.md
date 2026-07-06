---
name: one-pager
description: Draft a pitch one-pager — single-page named profile of a target company for an internal pitch meeting, MD review, or to support a banker's outreach. Use when the user asks for a one-pager, profile, target snapshot, or single-sheet pitch overview. Distinct from teaser (anonymised, pre-NDA) and CIM (long-form, post-NDA).
trigger: /one-pager
---

# One-Pager — Pitch Target Profile

## Overview

A single named-page profile of a target company: business, financials, valuation footprint, key catalysts. Built for internal MD review, pre-meeting prep, or as the supporting document behind an outreach. Reader gets the full picture in one sheet.

---

## Critical Constraints — read these first, every time

1. **One page. Exactly.** If content overruns, cut detail (not depth on what's on the page).
2. **Named, not anonymised.** Distinct from teaser. Real ticker, real name, real customers (where reportable / public).
3. **Cite every number.** Same discipline as the rest of the profile.
4. **Valuation footprint, not full models.** A small football field or 3-method range — not the underlying DCF / comps / LBO. Those live in `/dcf`, `/comps`, `/lbo` outputs.
5. **3 catalysts max.** Time-tagged. The biggest near-term events that move the thesis.
6. **No "we should pursue" / "we recommend" framing.** It's a profile; the MD/team decides next steps.
7. **Layout matters.** Density without clutter. Tables for numbers, bullets for narrative, header / footer with sourcing.

---

## Workflow

### Step 1 — Confirm scope
Target name + ticker (if public). Audience (MD / coverage banker / analyst). Purpose (pre-meeting / outreach support / internal pitch slide).

### Step 2 — Pull foundation (delegate to `filings-explorer`)
Latest 10-K business description; 3 years of P&L summary; latest quarter; debt + cash; share count.

### Step 3 — Pull peer context (delegate to `market-researcher`)
Sector + 3-5 peers + multiples. Light — full peer set lives in `/comps`, not here.

### Step 4 — Pull catalysts
Earnings dates, investor days, regulatory milestones, product launches, contract anniversaries — anything in next 12 months.

### Step 5 — Build valuation footprint
- Comps median (light)
- DCF central case (one number, low/high range)
- Optional: precedent transactions if M&A relevant

If a full `/dcf` and `/comps` have been done, summarise from those; don't redo.

### Step 6 — Assemble the page
Use the structure in *Output shape*. Block layout — header / business / financials / valuation / catalysts / footer.

### Step 7 — Trim to fit
If overrunning: cut catalyst count, narrow peer table, shorten business description. Prioritise: Header → Financials → Valuation → 1 catalyst > business detail.

### Step 8 — Generate the file

Default deliverable is a single slide (`.pptx`); switch to `.pdf` if the user explicitly asked for a printable.

**For `.pptx` (default):** hand off to `/pptx`. Specify:
- File: `<Ticker>_OnePager_<YYYYMMDD>.pptx`. 16:9 aspect, single slide.
- Asking-title headline (top of slide, navy, bold) — the recommendation in one sentence (e.g. "AAPL — 12% upside on 5Y DCF, services attach is the swing").
- Block layout matching *Output shape*: Header chip (ticker / sector / mkt cap / date) → Business 4-liner → Financials 3Y+LTM table → Valuation footprint table → Catalysts bullets → Footer source line.
- Source line at slide bottom (9pt grey italic): `Source: Company filings; FactSet (as of <date>); Ownware analysis`.
- Charts (when included — football field or peer multiples) rendered via matplotlib at `dpi=300` and inserted as images, using deck navy `#0A2A4A` not matplotlib defaults.

**For `.pdf` (printable):** hand off to `/pdf` (write mode) with the same content brief. Use the `/pdf` skill's page template for the header (codename + confidentiality stamp, when applicable) + footer + page number.

If the office skill reports a missing-Python error, surface its install instruction and stop. The deliverable is the file; do not paste an ASCII profile.

### Step 9 — **Final Output Checklist**

---

<correct_patterns>

### Single-page named profile

```
─────────────────────────────────────────────────────────────────
      APPLE INC. (NASDAQ: AAPL)         |    May 7, 2026
      Consumer Electronics              |    Mkt Cap: $3,180B
─────────────────────────────────────────────────────────────────

BUSINESS

Designs, manufactures, and markets smartphones, personal computers,
tablets, wearables, and accessories. Services segment includes the
App Store, advertising, AppleCare, cloud, payment services, and
subscription content. iPhone is ~52% of FY24 revenue; Services is
~25% and growing fastest. [Apple 10-K FY24, p. 1]

FINANCIAL SNAPSHOT

| Metric                | FY22A    | FY23A    | FY24A    | LTM       |
| Revenue ($B)          |  394.3   |  383.3   |  394.3   |  394.7    |
|   YoY growth          |  +7.8%   |  -2.8%   |  +2.9%   |  +5.4%    |
| Gross Margin          |  43.3%   |  44.1%   |  46.2%   |  46.4%    |
| Operating Income ($B) |  119.4   |  114.3   |  123.2   |  124.5    |
|   Margin              |  30.3%   |  29.8%   |  31.2%   |  31.5%    |
| Net Income ($B)       |   99.8   |   97.0   |   97.2   |   98.4    |
| Diluted EPS ($)       |    6.11  |    6.13  |    6.30  |    6.45   |
| Net debt ($B)         |   53.1   |   46.0   |   40.2   |   38.5    |

Source: 10-K FY22-24 [pp. 28-32]; Q2 FY26 10-Q for LTM.

VALUATION FOOTPRINT

| Method                       | Range       | Centre  | vs Current  |
| EV/EBITDA NTM (peer median)  | $185-$245   | $215    | -X% / +Y%    |
| DCF Base case (mid-yr conv)  | $185-$245   | $215    | -X% / +Y%    |
| Current price                |             | $YYY    | [FactSet 2026-05-06] |

NEAR-TERM CATALYSTS

  • Q2 FY26 earnings: 2026-07-25 — guide for Services growth + AI capex commentary
  • iPhone 17 launch event: ~Sep 2026 — refresh cycle inflection
  • EU DMA enforcement: rolling — App Store fee structure under review

─────────────────────────────────────────────────────────────────
Source: Apple 10-K + 10-Q filings; FactSet for live multiples; press
releases and IR calendar for catalyst dates.
─────────────────────────────────────────────────────────────────
```

Header (name + sector + cap + date), business, financial snapshot, valuation footprint, catalysts, footer with sources. One screen.

### Valuation footprint, not full model

```
| Method                   | Range       | Centre |
| Comps (EV/EBITDA NTM)    | $192-$245   | $218   |
| DCF (Base case)           | $185-$255   | $215   |
| Precedent (M&A premium)  | $215-$280   | $245   |   ← if M&A relevant
                                              ^
                                       blended PT $215-$245
```

Reader sees the range and the blended centre. If they want the underlying model, that's `/dcf` or `/comps`.

### Catalyst time-tags

```
  • Q2 FY26 earnings: 2026-07-25
  • Investor Day: 2026-09-16
  • EU DMA review: rolling (next decision ~Oct 2026)
```

Every catalyst has a date or window. "Soon" / "potentially" / "in the next year" don't carry information.

</correct_patterns>

<common_mistakes>

### WRONG: Two pages

```
[Page 1: Business + financials]
[Page 2: Valuation + catalysts]
```

One page. If content doesn't fit, cut detail — don't paginate.

### WRONG: Full DCF / comps embedded

```
[half the page is a 5x5 sensitivity table]
```

The one-pager carries the FOOTPRINT (range + centre). Full models live in `/dcf` and `/comps`. Reader can cross-reference.

### WRONG: Vague catalysts

```
  • Continued AI tailwind
  • Product cycle dynamics
```

Time-tag and specify: "iPhone 17 launch event ~Sep 2026" / "AI capex disclosure on Q2 call 2026-07-25."

### WRONG: "We should buy" / "Initiating a meeting"

```
"AAPL is an attractive name and we recommend the team pursue..."
```

It's a profile, not a recommendation. The reader / MD decides whether it's interesting.

### WRONG: Stale or unsourced multiples

```
"EV/EBITDA: 22×"   ← when?
```

Cite + date: "EV/EBITDA NTM: 22× [FactSet, 2026-05-06 close]" or note the substitute source if FactSet not configured.

### TOP 5 ERRORS

1. Two pages instead of one
2. Full DCF / comps embedded instead of footprint summary
3. Vague catalysts without dates
4. Recommendation language ("we should pursue")
5. Multiples without source dates

</common_mistakes>

---

## Quality Rubric

Every one-pager must maximise for:

1. **Single page** — fit, don't truncate.
2. **Named profile** — ticker, name, sector, cap, date in the header.
3. **Financial snapshot table** — 3 years + LTM, key metrics, cited.
4. **Valuation footprint** — 2-3 methods with ranges and current price.
5. **3 time-tagged catalysts** — dates or windows, not "soon."
6. **No recommendations** — profile only.

---

## Final Output Checklist

- [ ] `.pptx` (default) or `.pdf` (when user requested printable) generated and saved at the expected path. File name matches `<Ticker>_OnePager_<YYYYMMDD>.<ext>`.
- [ ] Asking-title headline carries the recommendation in one sentence; reader can read the headline alone and know the call.
- [ ] Single page; no overrun.
- [ ] Header carries ticker, name, sector, market cap, date.
- [ ] Business description ≤ 4 lines, cited.
- [ ] Financial snapshot — 3 years + LTM, 6-8 line items, footnote source.
- [ ] Valuation footprint — 2-3 methods, range + centre + current price.
- [ ] 3 catalysts max, each time-tagged with a date or specific window.
- [ ] All numbers cited (filings, FactSet substitute, IR calendar).
- [ ] No "we should" / "we recommend" / "initiate" framing.
- [ ] Footer with comprehensive source list.
