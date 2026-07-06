---
name: kyc
description: Build a KYC (Know Your Customer) document review against the rules grid — identity verification, ownership / UBO, sanctions / PEP screen, adverse media, source of funds. Each finding carries the source rule (BSA / AML / FCPA / OFAC / firm policy) and a remediation path. Use when the user asks for a KYC review, onboarding review, AML check, or compliance file review. Compliance signs off; the agent stages.
trigger: /kyc
---

# KYC — Know Your Customer Review

## Overview

A structured review of an entity / individual against the firm's KYC rules grid: identity, ownership transparency, sanctions / PEP exposure, adverse media, source of funds. Each item has a status and a fix path. Compliance signs off; this stages.

---

## Critical Constraints — read these first, every time

1. **Every flag has a fix path.** No flag without a remediation row.
2. **Cite every finding.** Source document name + page or web URL with date.
3. **Status vocabulary fixed.** `✓ Pass` / `⚠ Flag` / `✗ Fail` / `— N/A` / `? Pending — needs <X>`.
4. **Tier the rules by source.** Distinguish firm-policy items from regulatory items (BSA, AML, FCPA, OFAC, FinCEN CDD, EU AMLD). Every regulatory item carries the rule citation.
5. **Sanctions list coverage explicit.** OFAC SDN ≠ OFAC Consolidated ≠ EU Consolidated ≠ UN ≠ UK HMT ≠ World-Check. State which lists were screened and which were not.
6. **No "compliant" / "non-compliant" conclusions.** State findings; surface gaps; flag for compliance review.
7. **Risk tier matches the entity.** Low risk: streamlined. Medium: enhanced. High: full Enhanced Due Diligence (EDD) with senior compliance approval.

---

## Workflow

### Step 1 — Confirm scope
- Entity type (individual / corporate / fund / trust)
- Jurisdiction
- Risk tier (Low / Medium / High — usually pre-classified by relationship type)
- Documents available (ID, proof of address, corporate registry, beneficial-owner declarations, source-of-funds evidence)

### Step 2 — Identity verification
For individuals:
- Government-issued photo ID (driver's licence, passport)
- Proof of address (utility, bank statement)
- Cross-check: name, DOB, address consistent across documents

For corporates:
- Certificate of incorporation
- Articles / bylaws
- Latest filings with corporate registry
- Tax ID / EIN

### Step 3 — Beneficial ownership (UBO)
- For corporates: identify all beneficial owners ≥ 25% (FinCEN CDD threshold; lower in some jurisdictions)
- Each UBO: identity verified per individual rules above
- Ownership chain documented (any SPVs / holding companies / trusts in the chain are walked through to natural persons)
- Senior managers also identified for entities with no UBO ≥ 25%

### Step 4 — Sanctions and PEP screening
For the entity AND every UBO and senior manager:
- OFAC SDN list
- OFAC Consolidated list
- EU Consolidated list
- UN list
- UK HMT list
- (Internal lists if applicable)

Match results: `No match` / `Possible match (manual review required)` / `Confirmed match (block)`. Possible matches require name-similarity threshold + manual review.

PEP indicators:
- Government / political role (current or last 12 months)
- Family relationship to a PEP
- Close-associate relationship to a PEP

### Step 5 — Adverse media
For the entity AND every UBO:
- Search lookback (firm-policy minimum, typically 5 years)
- Categories covered: financial crime, fraud, corruption, sanctions evasion, regulatory enforcement
- Severity scaling: Low / Medium / High

### Step 6 — Source of funds / source of wealth
For high-risk and certain medium-risk:
- Verify the funds' origin (employment income, business sale, inheritance, investment returns)
- Documentary evidence required
- Reasonableness check vs apparent wealth

### Step 7 — Build the structured review (delegate to `diligence-runner`)
Hand the workstream + materials. It returns the row-by-row findings.

### Step 8 — Risk classification
Output: confirmed Low / Medium / High risk with the basis. Compliance reviewer makes the final determination.

### Step 9 — Generate the file via `/docx`

Hand off to `/docx`. KYC reviews are formal compliance documents that go into the regulated record. Specify:

- File: `<EntityCodename>_KYC_Review_<YYYYMMDD>_v<NN>.docx` (entity codename to keep PII out of file names; version bumps on each iteration so reviewers can track changes).
- Cover: codename, "KYC / Customer Due Diligence Review," review date, version, reviewer name placeholder (compliance fills in).
- Heading discipline: H1 per section (Identity Verification, Beneficial Ownership, Sanctions & PEP, Adverse Media, Source of Funds / Source of Wealth, Risk Classification, Findings & Remediation, Coverage Gaps, Sign-off), H2 below.
- TOC field after the cover.
- Tables for: identity verification rows (entity + each individual + document type + verification date + status), UBO chain (each layer + ownership %), sanctions screening matrix (each list × each subject + result + screening date), PEP indicators, source-of-funds documentation list. All use `Light Grid Accent 1`; reviewer-action columns right-aligned.
- **Rule citations** — wherever a finding triggers a regulatory rule, the cell carries the rule reference (e.g. `31 CFR § 1010.230(b)(1)` for UBO; `OFAC SDN list, 2026-05-07 update`). The agent does not interpret the rule; it cites and surfaces.
- **Conclusion discipline.** The risk classification (Low / Medium / High) is the agent's recommendation. The cover and the sign-off section explicitly state: "Compliance reviewer makes the final determination." The agent never writes "approved" or "cleared."

If `/docx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.docx`; KYC findings live in the regulated record, not in chat.

### Step 10 — Run **Final Output Checklist**

---

<correct_patterns>

### KYC review structure

```
## KYC Review — <Entity reference>, 2026-05-07
Risk tier (initial classification): Medium
Reviewer: <reviewer ID> | Approver: <pending compliance signoff>

### Entity
- Type: Corporate (LLC)
- Jurisdiction: Delaware, USA
- Tax ID: <last 4 only in shared materials>
- Reference: <internal ID>

### Identity & Ownership

| # | Item                                       | Rule (source)        | Status   | Finding                                  | Source                              | Remediation / Next                       |
|---|--------------------------------------------|----------------------|----------|------------------------------------------|-------------------------------------|------------------------------------------|
| 1 | Legal-entity name match across documents   | Firm-AML §3.1        | ✓ Pass   | Match across cert, registry, bank ref    | [Cert of Incorporation, p. 1]      | —                                        |
| 2 | Active corporate status                    | Firm-AML §3.2        | ✓ Pass   | Good standing per DE Sec of State        | [DE registry as of 2026-05-01]      | —                                        |
| 3 | UBO ≥ 25% identified                       | FinCEN CDD §1010.230 | ⚠ Flag   | Ownership chain stops at SPV; 28% holder | [Form W-8BEN-E, p. 2]               | Request shareholder register from corp sec |
| 4 | UBO identity verified (each)               | FinCEN CDD §1010.230 | ? Pending | UBO #1 verified; UBO #2 SPV — pending    | [ID docs received for UBO #1]       | Walk SPV to natural person (Item #3)     |
| 5 | Senior manager identified                  | Firm-AML §4.1        | ✓ Pass   | CEO + CFO identified, ID docs received   | [Onboarding form + ID docs]         | —                                        |

### Sanctions & PEP screening

| # | List                | Result      | Source date   | Notes                                |
|---|--------------------|-------------|---------------|--------------------------------------|
| 1 | OFAC SDN           | No match    | 2026-05-07    | —                                    |
| 2 | OFAC Consolidated  | No match    | 2026-05-07    | —                                    |
| 3 | EU Consolidated    | ⚠ Possible  | 2026-05-07    | UBO #1 name 92% similar to entry — manual review required |
| 4 | UN                 | No match    | 2026-05-07    | —                                    |
| 5 | UK HMT             | Not run     | —             | Coverage gap — request enabling      |

PEP indicators:
- UBO #1: no current government / political role; no family / close associate flagged.
- CEO: no current role; family relationship — none flagged.

### Adverse media (5-year lookback)

| Date       | Headline                                       | Severity | Source URL    | Action                            |
| 2024-08-15 | Civil suit (commercial dispute, settled 2025) | Low      | <URL>         | Note in file; no further action   |

### Source of funds / wealth

For Medium-risk: documentary evidence required.

| # | Item                            | Rule              | Status     | Finding                                      | Source                       | Remediation     |
|---|--------------------------------|-------------------|------------|----------------------------------------------|------------------------------|-----------------|
| 1 | Origin of funds explained       | Firm-AML §5.1     | ✓ Pass     | Sale of operating business in 2023           | [Sale agreement, audit report]| —               |
| 2 | Reasonableness vs declared wealth | Firm-AML §5.2     | ✓ Pass     | Consistent with declared net worth            | [Wealth declaration]         | —               |

### Coverage notes

- **Lists screened:** OFAC SDN, OFAC Consolidated, EU Consolidated, UN. **Not screened:** UK HMT (gap), World-Check (subscription required), FATF (manual screen pending).
- **Lookback:** 5y adverse media (firm policy minimum).
- **Documents reviewed:** [list].
- **Documents outstanding:** shareholder register for UBO #2 (SPV chain).

### Risk classification

Initial: Medium.
Confirmed pending UBO #2 chain resolution and EU Consolidated possible-match clearance.
**Compliance review required before final classification.**
```

Reader sees identity, UBO, sanctions, adverse media, source of funds, gaps, and a clear "compliance must review" handoff.

</correct_patterns>

<common_mistakes>

### WRONG: Concluding "compliant"

```
"KYC review complete. Entity is compliant."
```

Don't conclude. State findings; surface gaps. Compliance reviewer determines compliance status.

### WRONG: Missing list coverage

```
"Sanctions: clean."
```

Which lists? OFAC SDN ≠ OFAC Consolidated ≠ EU ≠ UN ≠ UK HMT. State explicitly which were screened.

### WRONG: UBO chain not walked

```
"UBO: SPV holds 38%."
```

That's not a UBO finding. UBO is a NATURAL PERSON. Walk the SPV chain to find them, or flag for follow-up.

### WRONG: Wrong rule citation

```
"UBO required by Firm-AML §3.1"   ← UBO is FinCEN CDD §1010.230
```

Cite the actual rule. Misciting a regulatory rule is worse than no citation.

### WRONG: PII in shared materials

```
"UBO: Sarah Johnson, DOB 1968-04-15, SSN 123-45-6789"
```

PII goes in the secure compliance system, not in shared materials. Use entity references / last-4-only / role descriptions in shared / portable documents.

### TOP 5 ERRORS

1. Concluding "compliant" / "non-compliant" (compliance's role)
2. Missing or unspecified list coverage in sanctions
3. UBO chain stopping at SPV instead of walking to natural person
4. Wrong / missing regulatory rule citations
5. PII in shared materials

</common_mistakes>

---

## Quality Rubric

Every KYC review must maximise for:

1. **Identity verification** — entity + UBOs walked to natural persons.
2. **Sanctions list coverage explicit** — which screened, which gap.
3. **Adverse media** — categorical search with severity rating.
4. **Source-of-funds** — documentary evidence per risk tier.
5. **Rule citations** — every regulatory item references the specific rule.
6. **No conclusion** — findings only; compliance signs off.

---

## Final Output Checklist

- [ ] `.docx` file generated via `/docx` and saved at the expected path. File name matches `<EntityCodename>_KYC_Review_<YYYYMMDD>_v<NN>.docx`.
- [ ] Document carries the explicit "Compliance reviewer makes the final determination" framing on the cover and in the sign-off section; agent has not written "approved" or "cleared" anywhere.
- [ ] Risk tier (initial) declared at top.
- [ ] Identity verification rows for entity + each individual involved.
- [ ] UBO chain walked to natural persons (or flagged with remediation if SPV intervenes).
- [ ] Sanctions screened against named lists; coverage gaps explicit.
- [ ] PEP indicators reviewed for entity + UBOs + senior managers.
- [ ] Adverse media with date / severity / URL.
- [ ] Source-of-funds review per risk tier.
- [ ] Every flag carries a remediation row.
- [ ] Every regulatory item cites its rule.
- [ ] No "compliant" / "non-compliant" conclusion.
- [ ] PII discipline — secure system only, not shared materials.
- [ ] Compliance review handoff line at end.
