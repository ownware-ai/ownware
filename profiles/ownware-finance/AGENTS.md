# Memory seed — Finance

These are facts about how this analyst works. The memory system replaces this file at runtime; it remains as a back-compat seed for first-run.

## Numbers and formatting

- Default to most-recent-FY for trailing numbers; flag explicitly when using TTM or NTM.
- Currency: USD millions in tables; spell out the unit on every figure outside tables.
- Date format: ISO (`YYYY-MM-DD`) for facts; `Q1 FY25` for fiscal periods.
- Negative numbers in financial tables: parentheses `(123)`, not minus signs.
- Percentages in tables: one decimal (`8.4%`).

## Identifiers

- Never fabricate ticker symbols, CIKs, ISINs, CUSIPs, LEIs, SEDOLs, or counterparty names — fetch them via `filings-explorer` if not provided.
- "Estimate" and "consensus" are different things. Estimate = your math. Consensus = market median (cite the feed).

## Modeling defaults

- Sensitivity tables use **odd dimensions** (5×5 or 7×7) so the base case sits dead-centre.
- Terminal value as a share of enterprise value should sit in **50–70%**. Outside that range, surface why.
- Operating expenses scale on **revenue**, not gross profit.
- Working capital changes are computed off **ΔRevenue**, not Revenue.
- Tax rate by default 21–28%; flag when using anything outside.
- Mid-year discount convention by default for DCF (periods 0.5, 1.5, 2.5, …); flag when switching to end-of-year.
- Terminal growth must be strictly less than WACC.

## Capital structure

- LBO entry leverage market reference: 5.5–6.5× EBITDA for sponsor-friendly assets, lower for cyclicals; cite the comp set, not the rule of thumb.
- Net debt = total debt − cash. Net cash position flips the sign on the equity bridge — surface it explicitly.
- Use diluted shares (options + RSUs + convertibles) for per-share work.

## Deliverable conventions

- **IC memos** lead with the recommendation gap (the question the IC has to vote on), then thesis, then risks, then the ask.
- **Earnings recaps** lead with the headline beat/miss line, then the three biggest read-throughs, then the line items.
- **One-pagers** are exactly one page — if the content overruns, cut, don't shrink the font.
- **CIMs** anonymise on every page; the project codename appears in headers, not the company name.
- **KYC reviews** carry, for every flag, the source rule + a remediation suggestion. No flag without a fix path.

## Citations

- Filings: `[<Company> <Form> <Period>, p. <N>]` — e.g., `[Apple 10-K FY2024, p. 38]`.
- Press releases: `[<Company> <Period> PR, <YYYY-MM-DD>]`.
- Earnings calls: `[<Company> <Period> call transcript, <MM:SS>]`.
- Macro: `[FRED <SERIES_ID>, <YYYY-MM> release]` — e.g., `[FRED CPIAUCSL, 2026-04 release]`.
- Paid feeds (when configured): `[<Provider>, <YYYY-MM-DD>]` — e.g., `[FactSet, 2026-05-06 close]`.
- Computed values: end the calculation block with the source(s) of every input that fed it.

## Discipline

- "I don't have that number" is always a valid response. Do not estimate without flagging.
- Forecast lines never start without `Forecast:`, `Estimate:`, `Assumption:`, or sit inside a `Forecast` / `Estimate` block.
- No investment / legal / tax / accounting advice — frame, don't recommend; surface where a qualified professional must sign off.
