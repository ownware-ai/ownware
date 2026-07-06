---
name: client-review
description: Build a quarterly client review pack for a wealth-management meeting — performance vs benchmark, allocation drift vs target, action items for the meeting, and tax / distribution status. Use when the user asks for a client review, quarterly meeting pack, performance review, or wealth client update. The advisor signs off on any allocation changes; the agent stages the work.
trigger: /client-review
---

# Client Review — Quarterly Wealth Meeting Pack

## Overview

The pack a wealth advisor walks through with their client at the quarterly review meeting. Covers performance vs benchmark, allocation drift, action items requiring decisions, and tax / distribution status. Designed to be the canonical agenda for a 45-60 minute meeting.

---

## Critical Constraints — read these first, every time

1. **No investment advice in the pack.** The advisor — a licensed professional — gives advice. The pack stages the data and frames the questions; the advisor signs off on any actual allocation changes.
2. **Performance vs benchmark, always.** Returns in isolation are uninterpretable. Vs the right benchmark for the strategy, vs the plan target, vs the prior year. Three reference points minimum.
3. **Allocation drift surfaced.** Where the portfolio sits today vs the target allocation. ±5% triggers a discussion; ±10% triggers a rebalance recommendation (advisor decides).
4. **Action items have decision prompts.** Each: a Yes/No question for the client. "Approve harvesting $Xk of losses in [account]?" — not vague "consider TLH opportunities."
5. **Tax-aware framing.** Distinguish taxable vs tax-deferred accounts. TLH and rebalancing implications are different by account type.
6. **Cite every number.** Performance from the custodian; allocation from the latest statement; benchmarks with date.
7. **Privacy.** Client-identifiable data goes ONLY to the advisor's pack — not into broader summaries or shared logs.

---

## Workflow

### Step 1 — Confirm scope
- Client identifier (advisor's internal reference; do NOT use full name in shared materials)
- Period (quarterly default; some advisors do semi-annual or annual)
- Target allocation (as set in the financial plan)
- Benchmark for each strategy (60/40, target-date 2040, all-equity, etc.)

### Step 2 — Pull custodian data
- Holdings + market values (per account)
- Performance (period and YTD)
- Cost basis (lots)
- Distributions YTD
- Pending settlements

### Step 3 — Build performance section
| Period | Portfolio | Benchmark | Variance | Plan target |
|---|---|---|---|---|
| Q1 FY26 | +X% | +X% | ±X bps | +X% |
| YTD | +X% | +X% | ±X bps | +X% |
| LTM | +X% | +X% | ±X bps | +X% |
| 3Y | +X% | +X% | ±X bps | +X% |

### Step 4 — Build allocation drift section
| Asset class | Target | Current | Drift | Within band? |
|---|---|---|---|---|
| US Equity | 50% | 56% | +6% | ⚠ outside |
| Intl Equity | 20% | 19% | -1% | ✓ within |
| Bonds | 25% | 21% | -4% | ✓ within |
| Cash | 5% | 4% | -1% | ✓ within |

### Step 5 — Action items (Yes/No prompts)
Each action item has a specific Yes/No prompt for the client. Examples:
- "Approve rebalancing back to target allocation? Trade list: sell $XK US equity, buy $YK bonds."
- "Approve realising $XK of long-term losses in [taxable account]?"
- "Approve $XK Roth conversion in [IRA] this year?"

### Step 6 — Tax / distribution status
- Realised gains/losses YTD (short-term, long-term)
- TLH opportunities (lots showing > $X loss)
- RMD status (if applicable; due dates)
- Estimated tax liability for the year

### Step 7 — Risks / changes since last review
- Major life events flagged (income change, family change, goals change)
- Outstanding open items from last review
- Plan changes the advisor is considering

### Step 8 — Generate the deliverables — `/pptx` (meeting deck) and `/xlsx` (drift detail)

Two files. The deck is for the meeting (advisor-led conversation); the workbook backs the allocation discussion when the client wants the underlying numbers.

**Deck via `/pptx`** — file: `<Client>_Review_Q<X>_<YYYYMMDD>.pptx`.
- 16:9; firm template if available, otherwise the default `/pptx` master.
- Slide order: Title (client name + period + advisor), Performance (portfolio vs benchmark vs plan target — chart + small table), Allocation drift (chart with target ranges), Action items (each a Yes/No prompt — single slide with 3-5 prompts), Tax status (realised gains + TLH opportunities + RMD if applicable), Risks / Changes (life events + plan changes), Next steps (advisor's planned follow-ups).
- Asking-title headlines on every slide. Source line at slide bottom (custodian + as-of date) on every exhibit slide.
- Chart colors use deck/firm tokens — no matplotlib defaults.

**Workbook via `/xlsx`** — file: `<Client>_Drift_Q<X>_<YYYYMMDD>.xlsx`.
- Sheets: `Inputs` (target allocation + bands + as-of date), `Holdings` (raw position list with cost basis + market value + tax lots), `Drift` (target vs current vs band-status), `TLH` (loss positions sorted by harvestable amount), `Output` (recommended trade list — generated as input to `/rebalance` if the user runs that next).
- Drift column uses conditional formatting (green within band, yellow approaching, red breached).

**Advisor-signoff framing.** Both files are the staged pack; the advisor signs off before the meeting, just like /rebalance staging trades. The agent never simulates client communication.

If either skill reports a missing-Python error, surface its install instruction and stop.

### Step 9 — Run **Final Output Checklist**

---

<correct_patterns>

### Performance section with three reference points

```
### Performance — Q1 FY26 + YTD

| Period          | Portfolio | Benchmark (60/40) | Variance vs Bench | Plan Target |
| Q1 FY26         | +4.2%     | +3.8%             | +40 bps           | +2.5%       |
| YTD             | +4.2%     | +3.8%             | +40 bps           | +2.5%       |
| LTM             | +12.8%    | +11.2%            | +160 bps          | +6.0%       |
| 3Y annualised   | +9.1%     | +8.4%             | +70 bps           | +6.0%       |
| Since inception | +7.2%     | +7.0%             | +20 bps           | +6.0%       |

Benchmark: 60% S&P 500 / 40% Bloomberg US Agg, rebalanced quarterly.
Source: [Custodian statement, period ending 2026-04-30].
```

Reader sees absolute return, vs benchmark, vs plan target. Three reference points.

### Allocation drift table

```
### Allocation — Current vs Target

| Asset Class       | Target | Current | Drift   | Within Band? | Action Required        |
| US Equity (Large) | 35%    | 39%     | +4%     | ✓ within     | —                      |
| US Equity (Small) | 10%    | 12%     | +2%     | ✓ within     | —                      |
| Intl Equity       | 15%    | 13%     | -2%     | ✓ within     | —                      |
| Bonds (Core)      | 30%    | 24%     | -6%     | ⚠ outside    | Discuss rebalance      |
| Bonds (HY)        | 5%     | 6%      | +1%     | ✓ within     | —                      |
| Cash              | 5%     | 6%      | +1%     | ✓ within     | —                      |

Drift bands: ✓ within ±5% / ⚠ ±5-10% / ✗ > ±10%.
Source: [Custodian statement, holdings as of 2026-04-30].
```

Reader sees what's outside band; advisor decides whether to rebalance.

### Action items as Yes/No prompts

```
### Action Items — Decisions for This Meeting

1. **Rebalance Bonds (Core) back to 30% target?**
   - Trade list: sell $24,000 of US Large Cap; buy $24,000 of Core Bonds (Vanguard Total Bond ETF).
   - Tax impact: estimated $0 in taxable accounts (using harvested losses); $1,200 in retirement accounts (tax-free).
   - **YES / NO**

2. **Harvest $8,400 of long-term losses in [account # last 4 digits]?**
   - Realised LTCG offset benefit: ~$2,100 at 25% bracket.
   - Wash-sale guarded: replacement security selected.
   - **YES / NO**

3. **Begin RMD planning for IRA (turning 73 in October)?**
   - Estimated 2026 RMD: $X.
   - Distribution timing options to discuss.
   - **YES / NO** (decision: schedule a planning session in the next 30 days)
```

Each action is a discrete decision the client can answer in the meeting.

</correct_patterns>

<common_mistakes>

### WRONG: Performance without benchmark

```
"YTD return: +4.2%"
```

Compared to what? Vs benchmark, vs plan target — three reference points minimum.

### WRONG: Investment advice from the pack

```
"We recommend the client move 10% of US equity into international equity."
```

The advisor (licensed professional) makes recommendations. The pack stages the data and frames the question. Replace with: "US equity is 6% above target. Discuss rebalancing."

### WRONG: Vague action items

```
"Discuss tax-loss harvesting opportunities."
```

Not actionable. Replace with: "Approve harvesting $8,400 of long-term losses in [account]? YES/NO."

### WRONG: Mixing taxable and tax-deferred without distinction

```
"Tax-loss opportunity: $X across portfolio."
```

TLH only matters in taxable accounts. Be explicit which accounts; tax-deferred accounts have different considerations (RMD planning, conversion timing).

### WRONG: Client-identifiable data in shared logs

```
Pack header: "Sarah Johnson — Q1 FY26 Review"
```

Use advisor's internal reference (e.g., "Client 4729" or initials). Personally-identifying information stays in the advisor's secure system.

### TOP 5 ERRORS

1. Performance reported without benchmarks
2. Investment advice in the pack (advisor's role, not the pack's)
3. Vague action items without Yes/No prompts
4. Tax framing without taxable / tax-deferred distinction
5. Client name / PII in shared materials

</common_mistakes>

---

## Quality Rubric

Every client review must maximise for:

1. **Performance triangulated** — vs benchmark, vs plan target, multiple periods.
2. **Allocation drift surfaced** — current vs target, with bands.
3. **Action items as Yes/No prompts** — concrete decisions for the meeting.
4. **Tax-aware framing** — taxable vs tax-deferred distinguished.
5. **No advice from the pack** — advisor signs off.
6. **Privacy** — no PII in shared materials.

---

## Final Output Checklist

- [ ] Both files generated: `<Client>_Review_Q<X>_<YYYYMMDD>.pptx` (meeting deck) and `<Client>_Drift_Q<X>_<YYYYMMDD>.xlsx` (drift detail).
- [ ] Deck slides carry asking-title headlines + source line on every exhibit; workbook drift column uses conditional formatting.
- [ ] Period and benchmark explicit.
- [ ] Performance table — portfolio / benchmark / variance / plan target across multiple periods.
- [ ] Allocation drift table — target / current / drift / within band.
- [ ] Action items — each as a Yes/No prompt with trade detail and tax impact.
- [ ] Tax / distribution status — realised gains, TLH opportunities, RMD if applicable.
- [ ] Open items from last review revisited.
- [ ] All numbers cited from custodian statement with as-of date.
- [ ] No investment advice text in the pack (advisor decides).
- [ ] No PII / client name in shared logs (advisor's internal reference only).
