---
name: buyer-list
description: Build a strategic and financial buyer universe for a sale process — ranked / tiered list with rationale, fit assessment, and contact pathway for each buyer. Use when the user asks for a buyer list, buyer universe, target list, suitor list, sponsor list, or "who should we talk to about X." Used in tandem with `/cim` and `/process-letter`.
trigger: /buyer-list
---

# Buyer List — Strategic + Sponsor Universe

## Overview

A structured universe of strategic and financial buyers ranked by fit and likelihood of engaging on a target. Each buyer gets a one-line rationale, a fit score, and a contact pathway. Output is what the deal team uses to plan outreach, sequence the process, and brief the seller on who's likely in / out.

---

## Critical Constraints — read these first, every time

1. **Sources for every buyer.** A strategic candidate needs a citation: recent acquisition activity, capital allocation rhetoric, segment overlap, capacity to pay. A sponsor candidate needs a citation: fund vintage, dry powder, sector pattern.
2. **Tiered, not flat.** Tier 1 (high probability + strong fit) → Tier 2 (medium) → Tier 3 (long-shot or strategic-pressure). 5–8 in Tier 1 is typical for a focused process; broader for an auction.
3. **Rationale specific.** "Could be interested" is not a rationale. "Acquired a similar asset (TICKX → 2024) at 11× EBITDA, retains a $XB acquisition budget per CFO's last call" is.
4. **Capacity assessment.** Strategic: free balance sheet capacity (cash + revolver) + reasonable leverage. Sponsor: dry powder remaining in the relevant fund + check size fit.
5. **Conflicts and constraints flagged.** Buyer is in a competing process, regulatory overhang (HSR / EU MDR), recent leadership change paralysing M&A, etc.
6. **No "must-call" / "guaranteed bidder" framing.** Probability assessments are qualitative — High / Medium / Low — based on the rationale.
7. **Coverage gaps surfaced.** Foreign strategics not screened, family offices not in the data, recent first-time-fund sponsors potentially missed.

---

## Workflow

### Step 1 — Confirm scope
- Target (sector / sub-sector / size)
- Process type — broad auction (Tier 1+2+3, 30+ buyers), limited (Tier 1+2, 10-15), targeted (Tier 1, 3-5)
- Strategic vs Sponsor split — both? sponsor-only (carve-out / take-private)? strategic-only (technology / IP transfer)?
- Geography constraints — US-only? US + EU? Global?

### Step 2 — Pull strategic universe (delegate to `market-researcher`)
- Direct competitors of the target
- Adjacent competitors (one product / segment over)
- Customers (vertical integration plays)
- Suppliers (vertical integration plays)
- Conglomerates / holding companies with platform exposure
- Foreign players entering the geography

For each, pull:
- Market cap (size to do the deal)
- Recent M&A history (active acquirer? what multiples? what sizes?)
- Stated capital allocation (CFO commentary, investor day language)
- Free balance sheet capacity (cash + revolver from latest 10-Q)

### Step 3 — Pull sponsor universe (delegate to `market-researcher`)
- Sponsors with sector-specific funds
- Sponsors with recent platform investments in the sub-sector
- Sponsors with dry powder appropriate to deal size
- Sponsors with carve-out experience (if applicable)
- Family offices and SWFs if appropriate to deal size

For each, pull:
- Latest fund vintage + size
- Dry powder estimate (size − calls made)
- Sector pattern (how many platform deals in the space)
- Recent deals in the sub-sector
- Hold-period orientation (long-hold vs traditional 5-7 year)

### Step 4 — Tier and rank
- **Tier 1** — strong strategic / sponsor fit, capacity, recent pattern of similar deals
- **Tier 2** — adjacent fit, capacity, less recent pattern
- **Tier 3** — long-shot or pressure-tester (drives competitive tension even if low probability)

### Step 5 — Write rationale + flags per buyer
Each row:
- Why they fit (quantified where possible)
- Capacity (cash + revolver / fund dry powder)
- Recent pattern (last 2-3 sector deals if any)
- Constraints / conflicts
- Probability (High / Medium / Low)
- Contact pathway (CEO / CFO / Head of Corp Dev / Sponsor Partner)

### Step 6 — Coverage gaps
What's not in the list and why:
- Foreign acquirers not screened (which geographies, why)
- First-time funds not in our data
- Strategics in regulatory overhang
- Sponsors at end-of-fund-life

### Step 7 — Generate the workbook via `/xlsx`

Hand off to `/xlsx` — the buyer list is fundamentally a database. Specify:

- File: `<Project>_BuyerList_<YYYYMMDD>.xlsx`.
- Sheets (canonical order): `Inputs` (process type, target description, screening criteria), `Strategic` (strategic universe), `Sponsor` (sponsor universe), `Tiering` (Tier 1/2/3 ranking with rationale), `Coverage_Gaps` (what's not screened + why), `Output` (per-tier summary counts + recommended outreach order).
- Named ranges: `Process_Type`, `Target_Description`, `Tier_1_Count`, `Tier_2_Count`, `Tier_3_Count` — tier counts derived by `COUNTIF` formulas off the per-tier columns so adding/moving a buyer auto-updates totals.
- Strategic sheet columns: Buyer Name, Geography, Strategic Fit (direct / adjacent / customer / supplier / conglomerate / foreign), Acquisition History, Capacity (mkt cap, leverage, recent activity), Likelihood (formula combining fit + capacity), Tier, Rationale, Flags.
- Sponsor sheet columns: Fund Name, Vintage, Dry Powder, Sector Pattern, Recent Deals (size + sector), Sweet Spot (formula vs target), Likelihood, Tier, Rationale, Flags.
- Tier column uses data-validation drop-down (1 / 2 / 3); Likelihood column uses conditional formatting (green ≥ 75%, yellow 50-75%, red < 50%).
- Each buyer row's "recent activity" cell carries a comment with the source (PitchBook / press / 10-K reference + date).

If `/xlsx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.xlsx`; an in-chat list isn't a buyer-list.

### Step 8 — Run **Final Output Checklist**

---

<correct_patterns>

### Tiered buyer table — strategics

```
### Strategic buyers — Tier 1

| #  | Buyer            | Mkt Cap ($B) | Free Cap ($B) | Rationale                                            | Recent Pattern                          | Probability | Contact Pathway                |
|----|------------------|--------------|----------------|------------------------------------------------------|------------------------------------------|-------------|---------------------------------|
| 1  | Microsoft (MSFT) | 3,180        | 95             | Direct overlap with target's enterprise SaaS; CFO has signaled $50B+ M&A budget [Q1 FY26 call, 22:14] | Acquired Citus Data 2019 ($75M) and three vertical SaaS in 2023-2024 | High        | Head of Corp Dev → CFO          |
| 2  | Salesforce (CRM) | 280          | 14             | Stated "platform expansion via M&A" priority [Investor Day 2025-09-12]; recent Mulesoft / Slack precedents | Mulesoft $6.5B, Slack $27B, recent +3 tuck-ins | High        | Corp Dev → CEO / CFO            |
| 3  | ServiceNow (NOW) | 200          | 8              | Adjacent platform; recent partnership announcements suggest acquisition interest | Two adjacent SaaS tuck-ins in 2024       | Medium-High | Corp Dev                        |
```

Each row: capacity, rationale, pattern, probability. Reader can tell why each name is in.

### Tiered sponsor table

```
### Sponsor buyers — Tier 1

| #  | Sponsor                 | Latest Fund (Vintage / Size) | Dry Powder ($B) | Rationale                                            | Recent Sector Deals                          | Probability | Contact Pathway       |
|----|-------------------------|-------------------------------|------------------|------------------------------------------------------|----------------------------------------------|-------------|------------------------|
| 1  | Vista Equity Partners   | VIII (2022) / $20B            | ~6              | Software-only; sector-perfect fit; check size in band | Acquired LogMeIn ($4.3B 2020), Pluralsight ($3.5B 2021) | High        | Software Partner       |
| 2  | Thoma Bravo             | XVI (2024) / $32B             | ~25             | Vertical SaaS pattern dominant; multiple platforms    | SaaS take-privates: Anaplan ($10.7B), SailPoint ($6.9B) | High        | Tech Partner           |
| 3  | Hellman & Friedman      | XI (2023) / $24B              | ~14             | Pattern of vertical SaaS at scale; multi-stage history | Acquired Ultimate Software ($11B with Blackstone), Goodleap | Medium-High | Tech / Vertical Partner|
```

Sponsor side mirrors strategic structure: capacity (dry powder), rationale, pattern, probability.

### Coverage gaps

```
### Coverage gaps

- **Foreign strategics:** Did not screen Asian or European players (limited cross-border M&A activity in this sub-sector; user can request expansion).
- **Family offices:** Not in our screen; could be relevant for $1-3B deals if sized down or partial recap.
- **End-of-fund sponsors:** Excluded sponsors at year 5+ of their current fund (less likely to deploy on new platforms).
- **Conflicting process:** TICK_X (Tier 1 candidate) is currently in their own auction process per [<source>]; flagged for sequencing.
```

Reader knows what's missing and why.

</correct_patterns>

<common_mistakes>

### WRONG: Buyer without rationale

```
| Vista | High Probability | Software-focused |
```

Too thin. Software-focused → list a recent deal, fund vintage, dry powder, check-size match.

### WRONG: No capacity check

```
"Strategic Tier 1: AAPL, MSFT, GOOGL, META"
```

Tech mega-caps as Tier 1 because they "could afford anything" misses what they actually buy. Pull recent M&A patterns and capital allocation language. AAPL hasn't done a >$3B deal in years — that's a different probability than MSFT.

### WRONG: Flat list, no tiering

```
"Buyers: list of 30 names, alphabetical."
```

Without tiers, the deal team doesn't know who to prioritize. Rank by probability + fit.

### WRONG: Ignoring conflicts

```
"Tier 1: TICK_X" (currently in their own sale process)
```

A conflicting process means TICK_X has zero bandwidth for an inbound. Flag and downgrade.

### WRONG: "Will bid" / "Won't bid" certainty

```
"Tier 1 (will bid): ..."
```

You can't know. Probability is qualitative — High / Medium / Low. Even Tier 1 candidates frequently pass.

### TOP 5 ERRORS

1. Buyers without specific rationale (capacity + pattern + capital allocation)
2. No capacity check (whether the buyer can actually fund the deal)
3. Flat list instead of tiered + ranked
4. Conflicts / regulatory overhang ignored
5. Certainty framing ("will bid") instead of probability framing

</common_mistakes>

---

## Quality Rubric

Every buyer list must maximise for:

1. **Tiered + ranked** — Tier 1 / 2 / 3 with probability per buyer.
2. **Capacity-checked** — strategic free cash + revolver, sponsor dry powder.
3. **Pattern-supported** — recent M&A activity backs each rationale.
4. **Conflicts flagged** — competing processes, regulatory, leadership changes.
5. **Contact pathway specified** — who at the buyer to reach.
6. **Coverage gaps surfaced** — what's not screened and why.

---

## Final Output Checklist

- [ ] `.xlsx` workbook generated via `/xlsx` and saved at the expected path. File name matches `<Project>_BuyerList_<YYYYMMDD>.xlsx`.
- [ ] Tier counts on the Output sheet are formula-driven (`COUNTIF` against the per-tier columns); Likelihood column uses conditional formatting.
- [ ] Process type confirmed (broad / limited / targeted) and list size matches.
- [ ] Strategic universe screened across direct, adjacent, customer, supplier, conglomerate, foreign.
- [ ] Sponsor universe screened with fund vintage + dry powder + sector pattern.
- [ ] Tiered into Tier 1 / 2 / 3 with rationale per buyer.
- [ ] Capacity checked for each — strategic free capital, sponsor dry powder.
- [ ] Recent M&A pattern cited per buyer (last 2-3 sector deals).
- [ ] Probability assessment qualitative (High / Medium / Low).
- [ ] Conflicts and regulatory overhang flagged.
- [ ] Contact pathway specified per buyer.
- [ ] Coverage gaps surfaced.
- [ ] No "will bid" certainty; no recommendation framing.
