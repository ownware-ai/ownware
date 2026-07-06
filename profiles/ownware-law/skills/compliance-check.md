---
name: compliance-check
description: Assess documents, policies, or practices against regulatory frameworks (GDPR, HIPAA, SOC2, etc.)
trigger: /compliance-check
allowedTools:
  - readFile
  - listFiles
  - glob
  - grep
  - web_search
  - web_fetch
  - agent_spawn
---

# Compliance Assessment Workflow

You are performing a regulatory compliance assessment. Follow these steps to produce a thorough, actionable report.

## Step 1: Scope Definition

Confirm with the user:
1. **Regulatory framework(s)**: Which regulation(s) to assess against?
   - GDPR (EU General Data Protection Regulation)
   - CCPA/CPRA (California Consumer Privacy Act / California Privacy Rights Act)
   - HIPAA (Health Insurance Portability and Accountability Act)
   - SOC 2 Type II (Trust Service Criteria)
   - PCI DSS (Payment Card Industry Data Security Standard)
   - SOX (Sarbanes-Oxley Act)
   - FERPA (Family Educational Rights and Privacy Act)
   - COPPA (Children's Online Privacy Protection Act)
   - ADA / WCAG (Accessibility)
   - ISO 27001 (Information Security Management)
   - NIST CSF (Cybersecurity Framework)
2. **What to assess**: Documents, code, policies, practices, or a combination?
3. **Scope boundaries**: Which systems, data types, or business units are in scope?

## Step 2: Document Gathering

- Read all documents the user provides or points to.
- Use `glob` and `grep` to find relevant files in the workspace:
  - Privacy policies, terms of service
  - Data processing agreements
  - Security policies, incident response plans
  - Employee handbooks, training records
  - Technical documentation, architecture docs
  - Configuration files that may reveal data handling patterns

## Step 3: Assessment

Spawn the `checker` subagent to perform the compliance assessment.

For each applicable requirement, the checker evaluates:

| Status | Meaning |
|---|---|
| COMPLIANT | Requirement fully met. Evidence cited. |
| PARTIAL | Partially addressed. Gaps identified. |
| NON-COMPLIANT | Requirement not met. Remediation needed. |
| NOT APPLICABLE | Requirement does not apply. Reason stated. |

### Framework-Specific Checklists

**GDPR**:
- [ ] Lawful basis identified for each processing activity
- [ ] Privacy notice / policy covers Articles 13-14 requirements
- [ ] Data subject rights procedures (access, rectification, erasure, portability, restriction, objection)
- [ ] Data processing agreements with all processors (Article 28)
- [ ] Records of processing activities (Article 30)
- [ ] Data protection impact assessments for high-risk processing (Article 35)
- [ ] Cross-border transfer mechanism (SCCs, adequacy decision, BCRs)
- [ ] Breach notification procedures (72-hour supervisory authority, undue delay to data subjects)
- [ ] Data Protection Officer designated (if required)
- [ ] Privacy by design and by default (Article 25)
- [ ] Data minimization and purpose limitation
- [ ] Storage limitation with defined retention periods

**HIPAA**:
- [ ] PHI identified and inventoried
- [ ] Minimum necessary rule applied
- [ ] Business Associate Agreements with all vendors handling PHI
- [ ] Administrative safeguards (risk analysis, workforce training, contingency plan)
- [ ] Physical safeguards (facility access, workstation security, device controls)
- [ ] Technical safeguards (access controls, audit controls, integrity controls, transmission security)
- [ ] Breach notification procedures (individual, HHS, media if >500)
- [ ] HIPAA Security Officer designated
- [ ] Patient rights procedures (access, amendment, accounting of disclosures)

**SOC 2**:
- [ ] Security: logical and physical access controls, system operations, change management
- [ ] Availability: SLAs, disaster recovery, business continuity, monitoring
- [ ] Processing integrity: quality assurance, error handling, completeness
- [ ] Confidentiality: classification, encryption, access restrictions, disposal
- [ ] Privacy: notice, choice/consent, collection, use/retention/disposal, access, disclosure, quality

## Step 4: Risk Prioritization

Categorize each finding by:
- **Severity**: Critical / High / Medium / Low
  - Critical: Immediate enforcement risk, active violation, data exposure
  - High: Significant gap, likely to be flagged in audit
  - Medium: Notable gap, should be addressed in next compliance cycle
  - Low: Minor improvement, best practice recommendation
- **Remediation effort**: Quick fix / Moderate / Significant
- **Priority**: Severity x likelihood of enforcement action

## Step 5: Compliance Report

Present the structured report:

```
## Compliance Assessment Report

**Framework**: [regulation name]
**Scope**: [what was assessed]
**Date**: [today's date]
**Assessed by**: AI Legal Assistant (Counsel)

### Overall Posture
[STRONG / ADEQUATE / NEEDS IMPROVEMENT / CRITICAL GAPS]

### Executive Summary
[2-3 sentences: overall state, biggest gaps, recommended priority actions]

### Findings by Category

#### Critical / Non-Compliant
[Each finding with: requirement, current state, gap, recommended remediation, effort estimate]

#### Partial Compliance
[Same structure]

#### Compliant
[Brief list of requirements met, with evidence references]

#### Not Applicable
[Brief list with reasons]

### Remediation Roadmap
[Prioritized list of actions, grouped by effort level]

### Disclaimer
This assessment was performed by an AI legal assistant for informational purposes. It does not constitute a formal audit or legal opinion. Engage qualified compliance professionals for official assessments.
```

## Rules
- Always specify which version/year of the regulation you are assessing against.
- Cite specific articles, sections, or control numbers for every finding.
- Do not mark something as COMPLIANT without identifying specific evidence.
- Do not mark something as NOT APPLICABLE without stating why.
- Be honest about limitations: you cannot assess physical security controls, interview employees, or test technical systems. Note these gaps.
