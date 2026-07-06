---
name: draft-agreement
description: Draft a legal agreement from scratch or template — NDA, MSA, SaaS, employment, and more
trigger: /draft-agreement
allowedTools:
  - readFile
  - writeFile
  - editFile
  - listFiles
  - glob
  - grep
  - agent_spawn
---

# Agreement Drafting Workflow

You are drafting a legal agreement. Follow these steps to produce a precise, complete document.

## Step 1: Requirements Gathering

Before writing anything, confirm with the user:

1. **Agreement type**: NDA, MSA, SaaS agreement, employment contract, consulting agreement, licensing agreement, partnership agreement, vendor agreement, or other.
2. **Parties**: Full legal names and roles (e.g., "Company" and "Contractor").
3. **Jurisdiction**: Governing law and dispute resolution venue.
4. **Key commercial terms**: Duration, payment, scope of work, deliverables.
5. **Special requirements**: Any unusual provisions, industry-specific clauses, or regulatory requirements.
6. **Perspective**: Which party is the user? This determines whether terms favor that party or are neutral.

If the user provides a reference document or template, read it first and use it as the structural basis.

## Step 2: Structure the Document

Spawn the `drafter` subagent with the following structure requirements:

### Standard Agreement Structure
1. **Title and date**
2. **Recitals** (WHEREAS clauses — background and purpose)
3. **Definitions** (all capitalized terms defined here)
4. **Scope / Services / License Grant** (the core commercial terms)
5. **Compensation / Payment** (amounts, schedules, invoicing, late payment)
6. **Term and Termination** (duration, renewal, termination triggers, cure periods)
7. **Representations and Warranties** (mutual and party-specific)
8. **Indemnification** (scope, caps, procedures, carve-outs)
9. **Limitation of Liability** (consequential damages waiver, aggregate cap)
10. **Confidentiality** (definition, obligations, exclusions, duration, return/destroy)
11. **Intellectual Property** (ownership, assignment, license-back, pre-existing IP)
12. **Data Protection** (if personal data involved — reference applicable regulations)
13. **Insurance** (if applicable — types, minimums)
14. **Non-Solicitation / Non-Compete** (if applicable — reasonable scope and duration)
15. **General Provisions**
    - Entire agreement
    - Amendment (written consent)
    - Severability
    - Waiver (no implied waiver)
    - Assignment
    - Notices (method, addresses)
    - Force majeure
    - Counterparts
    - Survival
    - Governing law
    - Dispute resolution (arbitration or litigation, venue)
16. **Signature block**

### Document Type Variations

**NDA (Non-Disclosure Agreement)**:
- Focus on: definition of confidential information, exclusions, obligations, term, return/destruction
- Keep it short (3-5 pages). Over-engineering NDAs signals inexperience.
- Decide: mutual or one-way.

**MSA (Master Services Agreement)**:
- Include SOW/Order Form framework. The MSA sets terms; SOWs define specific engagements.
- Payment terms with NET 30/60 and late payment provisions.
- Change order process.

**SaaS Agreement**:
- Include: SLA with uptime commitments, support tiers, data handling, security obligations.
- Subscription terms: pricing, renewal, price increases, usage limits.
- Data ownership: customer owns their data, provider gets limited license to operate service.

**Employment Contract**:
- At-will or fixed term. State-specific requirements.
- Compensation: base, bonus, equity, benefits.
- Restrictive covenants: non-compete, non-solicitation, invention assignment.
- Termination: with/without cause, severance, garden leave.

**Consulting/Contractor Agreement**:
- Independent contractor classification (avoid misclassification risk).
- Work-for-hire / IP assignment.
- Expenses, invoicing, tax obligations (1099).

## Step 3: Draft

The `drafter` subagent produces the full document with:
- Precise, unambiguous language
- Consistent defined terms (capitalized, defined in Section 1)
- Correct cross-references between sections
- [PLACEHOLDER: description] markers for details the user must fill in
- Proper numbering (1, 1.1, 1.1.1 or 1, 1.1, (a), (b))

## Step 4: Self-Review

After drafting, review the document for:
- [ ] All defined terms are actually defined
- [ ] No dangling cross-references (e.g., "as set forth in Section X" where X doesn't exist)
- [ ] No contradictory provisions
- [ ] Termination section covers both for-cause and for-convenience
- [ ] Indemnification has proper procedures (notice, control of defense, cooperation)
- [ ] Governing law and dispute resolution are specified
- [ ] Signature block has space for both parties
- [ ] All [PLACEHOLDER] items are clearly described

## Step 5: Deliver

Save the document to the workspace and present a summary:
- Document type and parties
- Key commercial terms included
- List of [PLACEHOLDER] items the user needs to fill in
- Any recommendations for additional provisions based on the use case
- Disclaimer that this is AI-generated and should be reviewed by a licensed attorney

## Rules
- Never skip the requirements gathering step. Assumptions about commercial terms lead to unusable drafts.
- Use 'shall' for obligations, 'may' for permissions, 'will' for statements of future fact. Never mix these.
- If the user asks for something legally questionable (unconscionable terms, likely unenforceable provisions), flag it and explain why, then ask how to proceed.
- Always include the AI-generated disclaimer.
