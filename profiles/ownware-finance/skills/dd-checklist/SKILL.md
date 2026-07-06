---
name: dd-checklist
description: Build a private-equity due-diligence checklist by workstream — commercial / financial / legal / IT / HR / ESG. Each row carries the question, the source the answer should come from, status (Pass / Flag / Fail / Pending / N/A), finding, and a remediation path for any flag. Use when the user asks for a DD checklist, due diligence list, workstream tracker, or "what should we be checking on this deal."
trigger: /dd-checklist
---

# Diligence Checklist — PE Due Diligence by Workstream

## Overview

A structured workstream-by-workstream checklist. Reader sees what's been verified, what's flagged, what's pending, and what to fix on each item. Designed to drive deal-team coordination and IC pre-read.

---

## Critical Constraints — read these first, every time

1. **Every flag has a fix path.** No flag without a remediation row. "Top customer concentration 38%" → fix: "Request customer-level revenue + tenure schedule; assess churn risk."
2. **Cite every finding.** Document name + page, data-room reference, or web source with date.
3. **Status vocabulary fixed.** `✓ Pass` / `⚠ Flag` / `✗ Fail` / `— N/A` / `? Pending — needs <X>`. Don't invent statuses.
4. **Workstreams scoped at the start.** Don't mix commercial DD with financial DD on the same row. One workstream per section.
5. **Stage-appropriate depth.** Preliminary diligence is breadth; confirmatory diligence is depth. Match the depth to the stage.
6. **Coverage gaps surfaced.** What's NOT in the checklist (e.g., "anti-corruption / FCPA review pending external counsel") is named at the bottom.
7. **No deal-recommendation language.** Don't conclude "the deal is fine." State findings; the IC decides.

---

## Workflow

### Step 1 — Confirm scope
- Target name + stage (preliminary / confirmatory)
- Workstream(s) covered (commercial / financial / legal / IT / HR / ESG / regulatory). One run = one workstream.
- Deal context (sponsor entry, carve-out, take-private — affects what to check)

### Step 2 — Pull materials (delegate to `filings-explorer` for public filings, work with data-room if private)
Most DD work product comes from the data room (private deals) or 10-K / 10-Q / proxy (public deals).

### Step 3 — Build the checklist (delegate to `diligence-runner`)
Hand `diligence-runner` the workstream + materials. It returns the structured rows. Each row: item / status / finding / source / remediation.

### Step 4 — Identify red flags
Surface any `✗ Fail` or `⚠ Flag` at the top of the deliverable. The deal team and IC need to see issues immediately, not buried in row 47.

### Step 5 — Coverage gaps section
What's NOT in this checklist:
- Workstreams not covered in this run
- Specialist diligence pending (FCPA, IT security, environmental)
- Information requests outstanding to management
- External advisors needed (legal, accounting, tax, IT)

### Step 6 — Generate the workbook via `/xlsx`

Hand off to `/xlsx`. The diligence checklist is a structured tracker — perfect for a workbook. Specify:

- File: `<Project>_DD_Checklist_<YYYYMMDD>.xlsx`.
- Sheets (canonical order): `Inputs` (workstream + stage + scope), `Red_Flags` (surfaced first; one row per flag with severity + remediation), `Checklist` (the main grid), `Coverage_Gaps` (workstreams not covered + specialists needed), `Output` (per-status counts + outstanding-actions summary).
- Checklist columns: Item, Workstream, Status (Pass / Flag / Fail / N/A / Pending), Finding, Source (filing + page or URL + date), Remediation, Specialist Needed, Owner, Due.
- Status column uses data-validation drop-down + conditional formatting (green Pass, yellow Flag/Pending, red Fail).
- Output sheet has per-status counts derived via `COUNTIF` (so the totals update as the analyst flips statuses).
- Every Source cell carries a comment with the full citation if a URL is too long for the cell.

If `/xlsx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.xlsx`.

### Step 7 — Run **Final Output Checklist**

---

<correct_patterns>

### Commercial diligence checklist (illustrative)

```
## Project Atlas — Commercial Diligence (Preliminary), 2026-05-07

### Red flags surfaced
- ⚠ Top customer concentration 38% of FY24 revenue (Item #4 below)
- ⚠ Win rate vs Competitor X declined 12pts over 3 years (Item #11 below)

### Checklist

| #  | Item                                                       | Status   | Finding                                                          | Source                                | Remediation / Next                                  |
|----|------------------------------------------------------------|----------|------------------------------------------------------------------|----------------------------------------|------------------------------------------------------|
| 1  | TAM definition (mgmt vs bottoms-up)                        | ⚠ Flag   | Mgmt TAM $12B; peer-set bottoms-up suggests $7-8B                  | [data room — TAM analysis 2026-Q1]    | Request mgmt's underlying segmentation and methodology |
| 2  | Market growth rate (3-year forward)                        | ✓ Pass   | 14% CAGR, consistent with industry analysts                       | [Gartner, IDC reports cited]          | —                                                    |
| 3  | Sub-segment dynamics (where target is overweight)          | ✓ Pass   | Target overweight in growing sub-segment (CAGR 22% vs market 14%) | [data room — sub-seg analysis]        | —                                                    |
| 4  | Top-10 customer concentration                              | ⚠ Flag   | Top customer = 38% of FY24 revenue                                 | [10-K FY24, p. 22 / data-room CRA]    | Request customer schedule with tenure + ARR + churn  |
| 5  | Average customer tenure                                    | ? Pending | Not in current data room                                          | —                                     | Request customer tenure schedule                     |
| 6  | NPS / satisfaction                                         | — N/A    | Private company; no public survey                                  | —                                     | Source via expert calls; commission survey if material |
| 7  | Competitive landscape (named direct competitors)           | ✓ Pass   | 3 direct competitors named; market share view consistent          | [data room competitive analysis]      | —                                                    |
| 8  | Pricing power (gross margin trajectory)                    | ✓ Pass   | Gross margin +120bp YoY, stable underlying                         | [10-K FY24, p. 32]                    | —                                                    |
| 9  | Sales cycle length                                         | ✓ Pass   | 4-6 months avg enterprise; consistent with peers                  | [data room funnel analysis]           | —                                                    |
| 10 | Win rate (overall)                                         | ✓ Pass   | 28% in enterprise pipeline, 35% mid-market                         | [data room funnel analysis Q1 FY26]   | —                                                    |
| 11 | Win rate vs key competitor                                 | ⚠ Flag   | Win rate vs Competitor X declined from 42% (FY22) to 30% (FY24)   | [data room funnel analysis]           | Investigate capability gap; lost-deal review         |
| 12 | Pipeline coverage (next 4 quarters)                        | ? Pending | Pipeline schedule not yet received                                 | —                                     | Request weighted pipeline by quarter, by segment     |
```

Reader sees the red flags, then audits the row-by-row work.

### Coverage gaps

```
### Coverage gaps in this run

- **Workstreams not covered:** financial DD, legal DD, IT security, ESG. Schedule for confirmatory phase.
- **Specialist needed:** FCPA / anti-corruption review (recommended given Latin America operations).
- **Information outstanding:** customer tenure schedule, weighted pipeline, lost-deal review (per remediation rows above).
- **External advisors:** none required at this stage; legal counsel for confirmatory phase.
```

The deal team knows what's missing.

</correct_patterns>

<common_mistakes>

### WRONG: Flag without remediation

```
| 4 | Top customer concentration | ⚠ Flag | 38% | [10-K p. 22] | (blank) |
```

Every flag carries a remediation. "Request customer schedule with tenure + ARR + churn" — concrete next step.

### WRONG: Mixing workstreams in one checklist

```
| 1 | TAM analysis | ... |
| 2 | Working capital | ... |
| 3 | Software licensing | ... |
| 4 | Employee retention | ... |
```

That's commercial + financial + IT + HR all jumbled. One workstream per checklist. If the user wants multi-workstream, that's multiple runs.

### WRONG: Hidden red flags

```
[Row 47: ⚠ Flag — material litigation pending]
```

Critical findings buried at row 47 won't get read. Surface red flags at the top of the deliverable.

### WRONG: Conclusion language

```
"Based on our diligence, the target is in solid shape and we recommend proceeding."
```

Don't. State findings; flag gaps; surface remediations. The IC decides.

### WRONG: Skipping "Pending — needs X"

```
| 12 | Pipeline coverage | (no entry) | ... |
```

If something can't be answered yet, mark it `? Pending — needs <specific data>`. Empty rows don't drive action.

### TOP 5 ERRORS

1. Flags without remediation (no fix path)
2. Mixing workstreams in one checklist
3. Red flags buried instead of surfaced at top
4. Deal-recommendation framing
5. Pending items left blank instead of marked with what's needed

</common_mistakes>

---

## Quality Rubric

Every DD checklist must maximise for:

1. **One workstream per checklist** — coherent scope.
2. **Every flag has a remediation** — concrete next step.
3. **Every finding cited** — document + page or data-room reference.
4. **Red flags surfaced at top** — IC and deal team see them immediately.
5. **Coverage gaps named** — what's NOT covered, what specialists are needed.
6. **No conclusions** — findings yes; recommendations no.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Project>_DD_Checklist_<YYYYMMDD>.xlsx`.
- [ ] Status column has data-validation + conditional formatting; Output-sheet status counts are formula-driven (`COUNTIF`).
- [ ] Workstream + stage (preliminary / confirmatory) declared at top.
- [ ] Red flags surfaced at the top, before the row table.
- [ ] Each row has: item / status / finding / source / remediation.
- [ ] Status vocabulary consistent (Pass / Flag / Fail / N/A / Pending — needs X).
- [ ] Every flag carries a remediation row.
- [ ] Every finding cited (document + page or web URL + date).
- [ ] Coverage gaps section names workstreams not covered, specialists needed, info outstanding.
- [ ] No deal-recommendation language.
