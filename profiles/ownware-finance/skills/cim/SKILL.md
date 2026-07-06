---
name: cim
description: Draft a Confidential Information Memorandum — anonymised investment overview prepared by the seller's advisor for distribution to qualified buyers. Includes investment highlights, business overview, products, customers, financials, management team, market opportunity, and process detail. Use when the user asks for a CIM, sale memo, info memo, or distributable bidder document. Distinct from `/teaser` (one-page anonymised) and `/one-pager` (pitch context).
trigger: /cim
---

# CIM — Confidential Information Memorandum

## Overview

A 30–60 page anonymised information memorandum the seller's advisor distributes to qualified buyers under NDA. Frames the investment opportunity, presents the business, and stages the process. Tone: aspirational but defensible — every claim sourced, every projection labeled as management's, anonymisation maintained until the data room opens.

---

## Critical Constraints — read these first, every time

1. **Anonymisation is total until disclosed.** Cover, header, body — the company name appears NOWHERE. Use the project codename (e.g., "Project Atlas") on every page until the recipient has executed an NDA AND the seller has elected to disclose identity.
2. **Customer concentration anonymised.** "Top customer ~XX% of FY24 revenue" — never name the customer in the body. Customers are Tier 1 / Tier 2 / Tier 3 with characteristics, not names.
3. **Forecast is management's, not the advisor's.** Every forward number labeled `Management projection:` or sits in a clearly demarcated `Management Forecast` section. The advisor's job is to present them with discipline; not to vouch for them.
4. **Cite every historical number.** Audited financials → audit report. Management commentary → call / meeting transcript with date. KPI claims → operational dashboard or supporting schedule.
5. **Don't manufacture KPIs.** If the company doesn't measure it, don't add it to the CIM.
6. **No "compelling investment" / "must-own" / "transformational" superlatives.** State the data; the buyer judges.
7. **Process page = how to bid + when.** Don't soft-pedal. Bidders want clarity on first-round expectations, second-round data-room access, management presentation timing.
8. **Verify with the user at three checkpoints** — investment highlights → financials section → process page — before releasing to bidders.

---

## Workflow

### Step 1 — Confirm scope
- Project codename (or pick one with the user — typically a placeholder name not related to the actual company)
- Audience: strategic / sponsor / both
- Process type: targeted / limited / broad auction
- Diligence packet readiness (data room status)

### Step 2 — Pull standalone financials (delegate to `filings-explorer` if public, or work with management materials if private)
3 years of P&L, BS, CF (audited where available); LTM; latest interim quarter.

### Step 3 — Pull operational data
- Customers (anonymised tiers + revenue concentration)
- Geographic split
- Product / service mix
- Backlog / RPO if applicable
- Headcount + key roles
- Pipeline / sales funnel if relevant

### Step 4 — Build investment highlights (5–7 bullets)
Each anchored to a quantitative anchor:
- "$X recurring revenue, growing at Y%, with NRR of Z%" — backed by management dashboard
- "X% gross margin, up Y bps over 3 years, driven by Z" — sourced
- "Top-3 customer concentration of X%, with average tenure of Y years" — sourced

### Step 5 — Pull market context (delegate to `market-researcher`)
- Market size + CAGR
- Competitive landscape (anonymised competitors when private; named when public peer set)
- Where the target is positioned (leader / challenger / niche)

### Step 6 — Assemble management section
Titles + tenure + brief credentials. Names are typically held until the management presentation phase — the CIM lists titles only.

### Step 7 — Process detail
- First-round bid date + content (price + structure preliminary)
- Q&A protocol
- Data-room opening timing
- Management-presentation timing
- Final-round bid date + content (mark-up of SPA + financing commitments)

**Stop and confirm with the user** the entire structure before drafting the document.

### Step 8 — Draft the CIM content (delegate to `deck-author`)
Use the section template below. `deck-author` produces the per-section markdown drafts. Maintain anonymisation discipline at every page — the codename, never the real name.

### Step 9 — Generate the file via `/docx`

Hand off to the `/docx` skill with the drafted content. Specify:

- File: `<Codename>_CIM_v1.0_<YYYYMMDD>.docx` (e.g. `Project_Atlas_CIM_v1.0_20260507.docx`).
- Cover page: codename, "Confidential Information Memorandum," month/year, version (`v1.0` for first send, bump for re-issues), `STRICTLY CONFIDENTIAL` stamp in red bold.
- TOC field after the cover; populates on Word open.
- Heading discipline: every section header uses `add_heading(text, level=N)` — never bold paragraphs. H1 for top-level sections (Executive Summary, The Company, Industry, Financials, Process), H2 for sub-sections, H3 below.
- Tables for all financials use `add_table` with a real `.style` (Light Grid Accent 1 default); numeric columns right-aligned.
- Different first-page header/footer enabled — cover has no page number; body pages carry `<Codename> — Confidential` in the header and a page-number field in the footer.
- **Anonymisation pass is non-negotiable for CIM-class output.** Before saving, the `/docx` skill runs a verify step asserting the real company name does not appear anywhere in the document body or table cells. A leak fails the build — surface to the user and stop.

If `/docx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.docx`; do not paste markdown back to the user as a substitute.

### Step 10 — Run **Final Output Checklist** + anonymisation audit

---

<correct_patterns>

### Anonymised cover page

```
                    PROJECT ATLAS

           Confidential Information Memorandum

                       May 2026


                  STRICTLY CONFIDENTIAL
   For the use of qualified prospective acquirers only

                    [Advisor name]
```

No company name. No logo. Codename + date + advisor.

### Investment highlight with quantitative anchor

```
**1. Mission-critical, recurring revenue platform with strong retention**

- $185mm of subscription revenue (74% of LTM revenue), growing 18% YoY [audited financials FY24]
- Net Revenue Retention of 119% (3-year average) reflects expansion within existing accounts [management dashboard, 2026-Q1 board materials]
- Gross retention of 96%, driven by mission-critical use case (top decile in industry per [Industry SaaS benchmarks 2025])
- ARR-to-revenue ratio: 0.92×, indicative of high-quality recurring base
```

A claim, then the underlying numbers, each cited. Reader can audit.

### Anonymised customer concentration

```
### Customer base

- 2,400+ active accounts across enterprise (>$1B revenue), mid-market, and growth segments
- Top customer represents ~14% of FY24 revenue (Tier 1 enterprise, Fortune 100 industrials)
- Top 5 customers represent 34% of FY24 revenue
- Top 10 customers represent 51% of FY24 revenue
- Average customer tenure: 6.4 years across the top 10

[Customer names redacted; full schedule available in data room post-NDA]
```

Named only by tier and segment. Concentration disclosed in aggregate. Schedule promised post-NDA.

### Management projection clearly labeled

```
### Financial projections (Management)

**These projections were prepared by management and reflect their current
expectations, business plan, and key assumptions. They have not been
independently verified. Recipients should make their own evaluation of the
opportunity.**

|                       | FY25E   | FY26E   | FY27E   | FY28E   |
| Revenue ($mm)         |  315    |  385    |  470    |  570    |
|   YoY growth          |  +25%   |  +22%   |  +22%   |  +21%   |
| Gross profit ($mm)    |  235    |  295    |  365    |  450    |
|   Gross margin        |  74.6%  |  76.6%  |  77.7%  |  78.9%  |
| Adjusted EBITDA ($mm) |   75    |  100    |  130    |  170    |
|   EBITDA margin       |  23.8%  |  26.0%  |  27.7%  |  29.8%  |

Source: Management plan, dated 2026-04-15; key assumptions in Appendix A
```

Big "Management" label, disclaimer, source. The advisor does not endorse the projections.

</correct_patterns>

<common_mistakes>

### WRONG: Company name leaks in the body

```
"Atlas (the 'Company') was founded in 2008 by John Smith..."
                    ↑
        forgot to redact 'John Smith' here
```

Anonymise everything: company name, founder names, customer names, location specificity that would identify (e.g., "headquartered in our Beijing office" → "headquartered in APAC HQ"). Run an anonymisation audit before release.

### WRONG: Advisor projections without management label

```
"Revenue is projected to grow 22% per year through FY28..."
```

Whose projection? The CIM is presenting MANAGEMENT'S plan. Label every forward number. The advisor doesn't make projections in a CIM — only presents them.

### WRONG: "Compelling" / "transformational" / "must-own"

```
"Project Atlas represents a compelling opportunity to acquire a transformational..."
```

Strip superlatives. The data should make the case; the prose stays neutral.

### WRONG: Soft-pedalling the process

```
"We are working with a select group of strategic and financial buyers
on a flexible timeline..."
```

Buyers want clarity. State the dates: first-round bid by date, second-round by date, expected close by date. Vague timelines slow the process and lose buyers.

### WRONG: Manufactured KPIs

```
"Customer Lifetime Value: $480K"   ← company doesn't track LTV
```

If the company doesn't measure CLV / NRR / DAU / etc., don't manufacture them. The CIM must reflect what the company actually tracks.

### TOP 5 ERRORS

1. Anonymisation leak (founder name, customer name, identifying location)
2. Projections without "Management" label and disclaimer
3. Superlative-laden prose ("compelling," "transformational")
4. Soft-pedalled process page (no dates, no clarity on bid format)
5. Manufactured KPIs the company doesn't actually track

</common_mistakes>

---

## Quality Rubric

Every CIM must maximise for:

1. **Anonymisation discipline** — codename only, no leaks anywhere in the body.
2. **Cited historical data** — every number anchored to filings / management materials.
3. **Management-labelled projections** — disclaimer present, advisor does not endorse.
4. **Quantitative-anchor highlights** — investment bullets backed by numbers.
5. **Clear process detail** — dates, formats, decision points all explicit.
6. **Neutral tone** — superlatives stripped; data carries the case.

---

## Final Output Checklist

- [ ] `.docx` file generated via `/docx` and saved at the expected path. File name matches `<Codename>_CIM_v1.0_<YYYYMMDD>.docx`.
- [ ] `/docx`'s anonymisation verify pass fired and confirmed no real-name leak before save (a leak fails the build).
- [ ] Codename used on every page; no real names in body.
- [ ] Customer names anonymised (Tier 1 / 2 / 3 with characteristics).
- [ ] Founder / management names held to management presentation phase.
- [ ] 3 years of audited financials present and cited.
- [ ] LTM and last quarter included.
- [ ] 5–7 investment highlights, each with a quantitative anchor and citation.
- [ ] Management projections labeled `Management plan` with disclaimer.
- [ ] Process page with first-round bid date, Q&A protocol, MP timing, final-round date.
- [ ] No superlatives ("compelling," "transformational," "must-own").
- [ ] Anonymisation audit run on every page before release.
- [ ] No projections, opinions, or recommendations from the advisor in the CIM.
