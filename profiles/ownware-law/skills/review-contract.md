---
name: review-contract
description: Comprehensive contract review — extract terms, flag risks, suggest redlines
trigger: /review-contract
allowedTools:
  - readFile
  - listFiles
  - glob
  - grep
  - agent_spawn
---

# Contract Review Workflow

You are performing a comprehensive contract review. Follow these steps systematically.

## Step 1: Intake

- Identify the document to review. If the user provided a file path, read it. If not, ask which document to review.
- Read the ENTIRE document before forming any opinions.
- Identify the document type: NDA, MSA, SaaS agreement, employment contract, vendor agreement, licensing agreement, partnership agreement, terms of service, or other.

## Step 2: Initial Scan

Spawn the `analyst` subagent to perform deep document analysis. It will extract:
- Parties and defined roles
- Key definitions
- Core obligations
- Payment terms
- Term and termination
- Liability and indemnification
- IP ownership
- Confidentiality
- Governing law and dispute resolution
- Assignment and change of control

## Step 3: Risk Assessment

Based on the analyst's findings, categorize every notable provision:

### HIGH RISK (requires negotiation before signing)
- Unlimited liability or uncapped indemnification
- One-sided termination rights
- Broad IP assignment beyond deliverables
- Auto-renewal with no or short opt-out window
- Non-mutual confidentiality or non-compete
- Waiver of jury trial without arbitration alternative
- Forum selection in unfavorable jurisdiction

### MEDIUM RISK (should negotiate, but not deal-breakers)
- Short cure periods (< 15 days)
- Broad definition of confidential information
- Vague deliverable or scope definitions
- Missing or weak SLAs
- Restrictive non-solicitation
- Limited termination for convenience

### LOW RISK (note but acceptable)
- Non-standard formatting or numbering
- Minor deviations from market terms
- Unusual but not harmful boilerplate variations

## Step 4: Missing Provisions Check

Flag if any of these standard clauses are absent:
- Force majeure
- Severability
- Entire agreement / integration
- Notices (with delivery method and addresses)
- Amendment (written consent requirement)
- Waiver (no implied waiver)
- Counterparts
- Survival (which sections survive termination)
- Data protection / privacy (if personal data is involved)

## Step 5: Redline Suggestions

For each HIGH and MEDIUM risk item, provide:
1. **Current language**: Exact quote with clause reference
2. **Issue**: What the problem is
3. **Suggested revision**: Alternative language
4. **Rationale**: Why this revision is warranted

## Step 6: Summary Report

Present a structured summary:

```
## Contract Review Summary

**Document**: [name/type]
**Parties**: [party names]
**Date**: [effective date if stated]
**Reviewed**: [today's date]

### Overall Assessment
[One paragraph: is this contract generally fair, one-sided, or heavily negotiated?]

### Risk Summary
- HIGH: [count] items
- MEDIUM: [count] items
- LOW: [count] items

### Key Findings
[Top 3-5 most important issues]

### Recommended Actions
[Numbered list of what the user should do next]

### Disclaimer
This review is provided by an AI legal assistant for informational purposes. It does not constitute legal advice. Consult a licensed attorney before executing any agreement.
```

## Rules
- Never skip Step 2 (full document read). Partial reads lead to missed context.
- Always include the disclaimer in the final report.
- Quote exact contract language when identifying risks. Paraphrasing introduces ambiguity.
- If you cannot determine the jurisdiction, ask before completing the review.
