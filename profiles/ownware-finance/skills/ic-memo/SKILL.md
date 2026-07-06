---
name: ic-memo
description: Draft an investment committee memo — the document the deal team submits to the IC ahead of a vote on whether to proceed with a transaction. Includes the recommendation gap, thesis, financial summary, returns, risks with mitigants, deal terms, and the ask. Use when the user asks for an IC memo, investment committee paper, deal memo, or pre-IC submission.
trigger: /ic-memo
---

# IC Memo — Investment Committee Memo

## Overview

The document the deal team submits to the IC ahead of a vote. Leads with the question the IC has to answer (the "ask"), frames the thesis and risks, presents the returns, and surfaces the gap between the deal team's view and the base case. Designed to drive IC discussion, not replace it.

---

## Critical Constraints — read these first, every time

1. **Lead with the ask.** Page 1, top: a single bold sentence with the IC question and the deal team's recommendation. The IC reads page 1 and knows what's being voted on.
2. **The "recommendation gap" is the heart.** Where does the deal team's view differ from the base-case assumption set, and why? The IC's job is to test that gap. If there's no gap, the deal isn't interesting enough to be at IC.
3. **Risks come in pairs.** Every risk has a mitigant or a monitoring signal. "Customer concentration risk" without "specific customers diversified post-close per LOI" is incomplete.
4. **Returns triangulated.** IRR + MOIC + cash-on-cash, with sensitivity. One number is not a return analysis.
5. **Cite every input.** Same discipline as the rest of the profile.
6. **No "we recommend pursuing the transaction" without the gap.** The recommendation must be specific to the structure, price, and timeline.
7. **Verify with the user at three checkpoints** — ask + recommendation gap → financial summary → risks — before assembling.

---

## Workflow

### Step 1 — Confirm scope
- Deal name (project codename or target)
- Stage (first IC / second IC / final approval)
- Specific decision being requested (e.g., "Approve $50M LOI at $X/share, subject to confirmatory DD")

### Step 2 — Articulate the ask
Single sentence, bolded. Examples:
- "**The IC is asked to approve a binding bid of $5.4B equity value (10.2× LTM EBITDA), subject to confirmatory DD completion by 2026-06-30.**"
- "**The IC is asked to allocate $40M to lead a Series C extension at $1.2B post-money, subject to lead-investor terms.**"

### Step 3 — Build the recommendation gap
Articulate where the deal team's view differs from a base-case observer's view. Examples:
- "Base case prices the deal off peer median of 9.5× EBITDA; we believe pro-forma synergies justify 10.2× given X."
- "Base case prices the deal at peer median; we believe management's plan is conservative on take-rate by 200bps, supporting our higher ROIC view."

This is the heart of the memo. The IC's job is to test this.

### Step 4 — Pull thesis (delegate where appropriate)
- Why this deal? (3-5 thesis bullets, each with quantitative anchor)
- Why now? (catalyst / timing logic)
- Why us? (competitive positioning, value-add post-close)

### Step 5 — Pull financial summary
- LTM revenue, EBITDA, FCF
- Forward projections (3-year, base case)
- Returns: IRR, MOIC, cash-on-cash with sensitivity (at minimum: 5×5 entry-exit multiple grid)
- Pro-forma leverage and covenant headroom

### Step 6 — Pull risks (delegate to `diligence-runner` if checklist work has been done)
3-5 risks. Each: probability, signal, mitigant.

### Step 7 — Pull deal terms
Structure (cash / stock / mix), price, financing sources, conditions, expected close.

### Step 8 — Draft the memo content (delegate to `deck-author`)
Use the structure in *Output shape*. `deck-author` produces the per-section markdown drafts. Memo is typically 8-15 pages plus appendix; leadership reads page 1, partners read pages 1-5, full IC reads everything.

### Step 9 — Generate the file via `/docx`

Hand off to `/docx` with the drafted content. Specify:

- File: `<Codename>_IC_Memo_<YYYYMMDD>.docx` (or `<Target>_IC_Memo_<YYYYMMDD>.docx` if internal-only and codename is not enforced).
- Cover page: codename / target name, "Investment Committee Memorandum," date, version, deal-team list.
- TOC field after the cover.
- Heading discipline: H1 for top-level sections (Recommendation, Thesis, Financials, Risks, Deal Terms, Returns, Process), H2 for sub-sections, H3 below.
- **Page 1 leads with the bolded ask sentence** — specific decision, structure, price, conditions. The first paragraph after H1 "Recommendation" is the ask. The reader must be able to read page 1 alone and understand the call.
- Tables for financial summary + returns sensitivity (`Light Grid Accent 1` style; numeric columns right-aligned). Returns sensitivity comes through as a 5×5 table (entry × exit multiple at minimum).
- Header on body pages: `<Codename> — IC Memo`; footer: `Page X of Y`.

If `/docx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.docx`; partners do not read markdown.

### Step 10 — Run **Final Output Checklist**

---

<correct_patterns>

### Page 1 — the ask + recommendation gap

```
                                                                           STRICTLY CONFIDENTIAL
─────────────────────────────────────────────────────────────────────────────────────────────────
                                       PROJECT ATLAS — IC MEMO

                                Investment Committee · 2026-05-07
─────────────────────────────────────────────────────────────────────────────────────────────────

THE ASK

**The IC is asked to approve a binding LOI of $5.4B equity value ($6.0B EV, 10.2× LTM EBITDA),
financed with $1.4B equity and $1.4B Term Loan B + Senior Notes, subject to confirmatory DD
completion by 2026-06-30 and final IC approval thereafter.**

THE RECOMMENDATION GAP

The base case observer would price this asset at peer median (9.5× LTM EBITDA → $5.0B EV).
Our view supports a 70bps premium for three reasons:

  1. Post-close gross margin lift of ~150bps from cost-out programme (sourced; cited in
     Financial Summary, p. 4). Worth ~$50M of run-rate EBITDA = ~+0.4× turn.
  2. Pricing power confirmed by recent customer-level pricing actions (+8% on net new
     contracts, with no observed churn lift) [data room CRA Q1 FY26]. Worth ~+0.2× turn.
  3. Strategic option value: the asset becomes a platform for two adjacent tuck-ins we
     have under conversation. Not credited in the base case, but real.

The IC's job tonight is to test these three premises. If two of three hold, the deal
clears our return hurdle (24%+ IRR base case). If one of three, returns compress to
sponsor-typical (18-20%). If none, we should pass.

HEADLINE RETURNS (Base case)

  Entry equity:       $1,400M
  Exit equity (Y5):   $4,250M
  IRR:                24.6%
  MOIC:               3.0×

  Sensitivity (Base IRR ranges):
    Bear (no synergies, no pricing):   12.4% IRR, 1.8× MOIC
    Bull (full thesis):                32.1% IRR, 4.0× MOIC
```

Page 1: ask, recommendation gap (the part the IC tests), headline returns, range. Five blocks.

### Risks with mitigants and signals

```
KEY RISKS

| # | Risk                                              | Probability | Signal to Monitor                          | Mitigant / Pre-close Action                |
|---|---------------------------------------------------|-------------|--------------------------------------------|---------------------------------------------|
| 1 | Top customer (~25% revenue) renegotiates pricing  | Medium      | Renewal cycle Q3 FY26                      | Diversification clauses in LOI; bridge financing committed if renewal slips |
| 2 | Cost-out plan delivers <60% of run-rate by Y2    | Medium      | First wave headcount actions Y1; benchmark vs peers' integration playbooks | 100-day plan with named ops partner; hold gate at Y1 review |
| 3 | EU regulatory action on data localisation        | Low-Medium  | Draft regs Q1 FY26; consultations ongoing  | Existing EU infrastructure; legal opinion confirms current compliance |
| 4 | Integration bandwidth (target's CTO transition)  | Low         | CTO retention; technical roadmap continuity | Retention package agreed in LOI; CTO+1 also retained |
```

Each risk: probability + signal + mitigant. The IC tests probabilities and challenges mitigants.

</correct_patterns>

<common_mistakes>

### WRONG: No specific ask

```
"We are pleased to bring Project Atlas to IC for discussion and approval to proceed."
```

What does "approve to proceed" mean? Bidding range? Final price? LOI vs definitive? Time-bound?
The ask is a single specific sentence: "Approve LOI at $5.4B EV, subject to DD by 2026-06-30."

### WRONG: Recommendation gap absent

```
"We recommend the IC approve this transaction."
```

Why is the deal team's view different from the base case? If it isn't, this isn't an alpha deal. State the gap, defend it, let the IC test it.

### WRONG: Risk list without mitigants

```
"Risks: customer concentration, cost-out execution, regulatory."
```

Empty list. Each risk needs probability + signal + mitigant.

### WRONG: Returns as a point estimate

```
"Base IRR: 24.6%."
```

The IC is voting on a range, not a point. Show Bear / Base / Bull. Show key sensitivities.

### WRONG: Marketing-speak

```
"Project Atlas represents a transformational opportunity to acquire a market leader at attractive valuation."
```

Strip superlatives. The IC reads numbers, not adjectives.

### TOP 5 ERRORS

1. Vague ask (not a specific decision in a single sentence)
2. No recommendation gap (deal team's view = base case → why is this at IC?)
3. Risks without mitigants and monitoring signals
4. Returns as point estimate, no sensitivity
5. Marketing-speak / superlatives

</common_mistakes>

---

## Quality Rubric

Every IC memo must maximise for:

1. **Specific ask** — single sentence, IC knows what they're voting on.
2. **Recommendation gap** — where deal-team view differs from base case, defended.
3. **Risks paired with mitigants and monitoring signals.**
4. **Returns triangulated** — IRR + MOIC + cash-on-cash, with sensitivity.
5. **Cited inputs** — every number traces.
6. **No marketing-speak** — neutral tone, data-driven.

---

## Final Output Checklist

- [ ] `.docx` file generated via `/docx` and saved at the expected path. File name matches `<Codename>_IC_Memo_<YYYYMMDD>.docx`.
- [ ] Heading styles applied (Heading 1 / Heading 2 — not bold paragraphs); TOC field present.
- [ ] Page 1 leads with bolded ask sentence (specific decision, structure, price, conditions).
- [ ] Recommendation gap section articulates where deal-team view differs from base case, with defense.
- [ ] 3-5 thesis bullets, each with quantitative anchor and citation.
- [ ] Financial summary with LTM + projected, with returns triangulated.
- [ ] Returns sensitivity (at minimum: entry × exit multiple, 5×5).
- [ ] 3-5 risks, each with probability + signal + mitigant.
- [ ] Deal terms section: structure, price, financing, conditions, close timing.
- [ ] DD status section (workstreams complete, pending, gaps).
- [ ] No "transformational" / "must-do" / superlatives.
- [ ] No fabricated synergies or sponsor-side numbers without citation.
