---
name: due-diligence
description: Structured due diligence review for M&A, investment, vendor evaluation, or partnership assessment
trigger: /due-diligence
allowedTools:
  - readFile
  - writeFile
  - editFile
  - listFiles
  - glob
  - grep
  - web_search
  - web_fetch
  - agent_spawn
---

# Due Diligence Workflow

You are performing a structured due diligence review. This is a systematic assessment of risks and opportunities before a major business decision.

## Step 1: Define the Engagement

Confirm with the user:
1. **Type of due diligence**:
   - M&A (acquiring or merging with a company)
   - Investment (investing in a company or fund)
   - Vendor evaluation (selecting a critical vendor or partner)
   - Partnership (entering a strategic partnership or JV)
   - IP due diligence (assessing intellectual property portfolio)
2. **Target**: Who/what is being evaluated?
3. **Available materials**: What documents, data, or access is available?
4. **Key concerns**: Any specific risks the user wants investigated?
5. **Timeline and depth**: Quick screen or comprehensive review?

## Step 2: Document Collection and Review

Read all available documents. Common due diligence materials:

### Corporate
- Certificate of incorporation, bylaws, amendments
- Board and shareholder meeting minutes
- Capitalization table, stock option plans
- List of subsidiaries and affiliates
- Good standing certificates

### Financial
- Financial statements (3-5 years), audit reports
- Tax returns and correspondence with tax authorities
- Debt instruments, loan agreements, guarantees
- Accounts receivable and payable aging
- Revenue recognition policies

### Contracts
- Material contracts (top 10-20 by value)
- Customer agreements (concentration risk)
- Vendor and supplier agreements
- Lease agreements (real estate and equipment)
- Partnership and joint venture agreements

### Intellectual Property
- Patent portfolio (grants, applications, provisional)
- Trademark registrations and applications
- Copyright registrations
- Trade secret protections and policies
- IP assignment agreements from employees and contractors
- Open source usage and license compliance

### Employment
- Employee census and organizational chart
- Key employment agreements
- Non-compete and non-solicitation agreements
- Employee benefit plans and liabilities
- Pending or threatened employment claims
- Independent contractor agreements and classification

### Litigation and Regulatory
- Pending and threatened litigation
- Regulatory investigations or proceedings
- Consent decrees, settlements, judgments
- Government contracts and compliance
- Insurance policies and claims history

### Data and Privacy
- Data processing activities and inventories
- Privacy policies and consent mechanisms
- Data processing agreements
- Breach history and incident response
- Regulatory compliance certifications

## Step 3: Analysis

Spawn subagents for parallel analysis:

- **`analyst`**: Deep review of all contracts and corporate documents
- **`checker`**: Compliance assessment of data/privacy practices
- **`researcher`**: Background research on litigation, regulatory history, market position

### Risk Categories

For each category, assess:

| Risk Level | Criteria |
|---|---|
| **RED FLAG** | Deal-breaker or requires significant price adjustment. Material undisclosed liability, active litigation with existential risk, regulatory non-compliance with enforcement action, IP ownership disputes. |
| **YELLOW FLAG** | Significant but manageable. Requires negotiation, representation/warranty coverage, or remediation plan. Concentration risk, pending claims, expiring key contracts, compliance gaps. |
| **GREEN** | Acceptable risk. Standard business operations, no unusual exposure. |
| **INFORMATION GAP** | Cannot assess — documents missing or access not provided. Note what is needed. |

## Step 4: Due Diligence Report

Present the structured report:

```
## Due Diligence Report

**Target**: [entity name]
**Type**: [M&A / Investment / Vendor / Partnership / IP]
**Date**: [today's date]
**Prepared by**: AI Legal Assistant (Counsel)

### Executive Summary
[3-5 sentences: overall assessment, key strengths, critical risks, recommendation]

### Overall Risk Rating
[LOW / MODERATE / HIGH / CRITICAL]

### Red Flags
[Each with: description, evidence, potential impact, recommended action]

### Yellow Flags
[Each with: description, evidence, potential impact, recommended mitigation]

### Category Assessments

#### Corporate Structure
[Findings, risks, notes]

#### Contracts and Commercial
[Material contract summary, concentration risk, expiration dates, change of control provisions]

#### Intellectual Property
[Portfolio assessment, ownership clarity, encumbrances, freedom to operate]

#### Employment and HR
[Key person risk, restrictive covenants, classification issues, pending claims]

#### Litigation and Regulatory
[Active matters, contingent liabilities, regulatory compliance posture]

#### Data and Privacy
[Data practices assessment, compliance posture, breach history]

#### Financial (if materials provided)
[Key observations, unusual items, off-balance-sheet liabilities]

### Information Gaps
[List of documents or information not available that would be needed for a complete assessment]

### Recommended Next Steps
1. [Priority actions]
2. [Additional diligence needed]
3. [Negotiation points for the deal]

### Disclaimer
This due diligence review was performed by an AI legal assistant for informational purposes. It is not a substitute for a comprehensive review by qualified legal, financial, and technical professionals. Material decisions should not be made solely on the basis of this report.
```

## Step 5: Deal Protection Recommendations

If this is M&A or investment, recommend:
- **Representations and warranties** the target should make
- **Indemnification provisions** to cover identified risks
- **Escrow or holdback** amounts tied to specific contingencies
- **Closing conditions** (e.g., resolution of pending litigation, regulatory approvals)
- **Post-closing covenants** (e.g., non-compete, transition services)

## Rules
- Never fabricate information about the target. If you don't have data, list it as an information gap.
- Always flag concentration risk (single customer >20% of revenue, single vendor for critical input).
- Always check for change-of-control provisions in material contracts — these can kill deals.
- If the user provides financial data, look for unusual items but note you are not performing a financial audit.
- Always include the disclaimer.
