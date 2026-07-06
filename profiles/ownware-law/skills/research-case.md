---
name: research-case
description: Research case law, statutes, and legal precedent on a specific legal question
trigger: /research-case
allowedTools:
  - readFile
  - writeFile
  - listFiles
  - glob
  - grep
  - web_search
  - web_fetch
  - agent_spawn
---

# Legal Research Workflow

You are performing targeted legal research. The goal is to find and analyze relevant legal authority on a specific question.

## Step 1: Define the Research Question

Confirm with the user:
1. **The question**: What specific legal issue or doctrine?
2. **Jurisdiction**: Federal, state (which state), international? Specific circuit or court?
3. **Area of law**: Contract, tort, IP, employment, privacy, corporate, securities, real estate, family, criminal, administrative, constitutional, or other.
4. **Purpose**: Background understanding, litigation support, transaction planning, compliance, or academic?
5. **Scope**: Broad survey or narrow, deep dive on a specific point?

## Step 2: Research

Spawn the `researcher` subagent for comprehensive legal research.

### Research Strategy

**Phase 1 — Primary Authority**
Search for directly applicable law in this order:
1. **Statutes and codes**: Federal (U.S.C.) or state statutes on point
2. **Regulations**: CFR, state administrative codes, agency guidance
3. **Case law**: Supreme Court, then circuit/appellate courts, then district/trial courts
4. **Recent decisions**: Last 2-3 years for evolving areas of law

**Phase 2 — Contextual Authority**
If primary authority is sparse or the issue is novel:
5. **Analogous jurisdictions**: How have other states/circuits addressed this?
6. **Secondary sources**: Restatements, law review articles, treatises, ALR annotations
7. **Legislative history**: If statutory interpretation is at issue
8. **Pending legislation or rulemaking**: If the area is actively evolving

**Phase 3 — Adverse Authority**
Always search for:
9. **Contrary holdings**: Cases reaching the opposite conclusion
10. **Circuit splits**: Differing approaches across jurisdictions
11. **Distinguishing factors**: Why adverse authority may not apply to the user's situation

### Source Quality Hierarchy

| Priority | Source Type | Weight |
|---|---|---|
| 1 | Supreme Court decisions | Binding on all |
| 2 | Circuit court (same circuit) | Binding |
| 3 | Circuit court (other circuits) | Persuasive |
| 4 | State supreme court (same state) | Binding (state law) |
| 5 | State appellate court | Binding (state law) |
| 6 | Federal district court | Persuasive |
| 7 | Restatements | Highly persuasive |
| 8 | Law review articles | Persuasive (analysis) |
| 9 | Agency guidance | Persuasive (regulatory) |

## Step 3: Analysis and Synthesis

Once research is complete:

1. **Organize by relevance**: Strongest authorities first
2. **Distinguish binding vs. persuasive**: Note jurisdiction and court level for each
3. **Identify the majority rule**: What do most jurisdictions hold?
4. **Identify minority rules**: Any significant departures?
5. **Trace doctrinal evolution**: Has the law been trending in a direction?
6. **Flag risks**: Where is the law unsettled, split, or evolving?

## Step 4: Research Report

Present findings in this structure:

```
## Legal Research Report

**Question**: [the legal question]
**Jurisdiction**: [applicable jurisdiction]
**Area of Law**: [category]
**Date**: [today's date]
**Researched by**: AI Legal Assistant (Counsel)

### Summary of Findings
[2-3 sentences: the current state of the law on this question]

### Applicable Statutes and Regulations
[Cite each with section number, title, and brief description of relevance]

### Key Cases

#### [Case Name], [Court] ([Year])
- **Holding**: [one sentence]
- **Facts**: [key facts relevant to the research question]
- **Relevance**: [why this case matters for the user's question]
- **Status**: [still good law / distinguished / overruled / limited]

[Repeat for each significant case, ordered by relevance]

### Majority vs. Minority Approaches
[If there is a split, describe each approach and which jurisdictions follow each]

### Adverse Authority
[Cases or arguments that cut against the user's position, with analysis of how to distinguish]

### Open Questions and Risks
[Areas where the law is unsettled, evolving, or where reasonable minds differ]

### Practical Implications
[What this research means for the user's specific situation]

### Research Limitations
[Databases not accessed, jurisdictions not covered, areas where deeper research would be valuable]

### Disclaimer
This research was conducted by an AI legal assistant. Citations should be independently verified through official legal databases (Westlaw, LexisNexis, or official court/government sources). This does not constitute legal advice.
```

## Rules
- NEVER fabricate a case citation. If you cannot find a case, say so. A gap in research is recoverable; a fake citation destroys credibility.
- Always note when you're citing a case from a different jurisdiction as persuasive authority.
- Check whether cases are still good law where possible. Note if a decision has been reversed, overruled, or limited.
- If the user's question spans multiple legal issues, break the research into sub-questions and address each.
- Always recommend independent verification through official legal databases — web search has limitations for legal research.
