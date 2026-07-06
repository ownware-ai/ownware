---
name: legal-memo
description: Research a legal question and produce a formal memorandum with analysis and citations
trigger: /legal-memo
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

# Legal Memorandum Workflow

You are producing a formal legal memorandum. This is a structured analysis of a legal question with research, application, and a conclusion.

## Step 1: Frame the Question

Confirm with the user:
1. **The legal question**: What specific issue needs analysis?
2. **Jurisdiction**: Which state/country/federal circuit? This determines which law applies.
3. **Relevant facts**: What are the key facts of the situation?
4. **Audience**: Internal memo (for the team) or external memo (for a client)?
5. **Depth**: Quick analysis (2-3 pages) or comprehensive memo (5-10+ pages)?

## Step 2: Research

Spawn the `researcher` subagent to find:
- **Primary authority**: Statutes, case law, regulations directly on point
- **Secondary authority**: Treatises, restatements, law review articles for context
- **Recent developments**: Any pending legislation, recent decisions, or regulatory changes

The researcher should search for:
- The specific legal doctrine or statute at issue
- Leading cases (landmark decisions, recent appellate rulings)
- Any circuit splits or conflicting authority
- Analogous cases with similar fact patterns

## Step 3: Draft the Memorandum

Spawn the `drafter` subagent to produce the memo in standard IRAC format:

### Memorandum Structure

```
MEMORANDUM

TO:      [Recipient]
FROM:    [Counsel — AI Legal Assistant]
DATE:    [Today's date]
RE:      [Subject line — concise description of the legal question]

────────────────────────────────────────────────

I. QUESTION PRESENTED

[One to three sentences framing the legal question. Start with "Whether..." or "Under [jurisdiction] law, does/can/may..."]

II. SHORT ANSWER

[Direct answer in 2-4 sentences. Lead with "Yes," "No," "Likely yes," or "Likely no." Then the key reasoning in one sentence. Then the main caveat or qualifier.]

III. STATEMENT OF FACTS

[Relevant facts in narrative form. Include only facts that bear on the legal analysis. Present objectively — this section does not argue.]

IV. DISCUSSION

[This is the core analysis. Use IRAC for each sub-issue:]

A. [First Sub-Issue]

   1. Rule: [State the legal rule — statute text, holding from leading case, regulatory standard. Cite everything.]

   2. Application: [Apply the rule to the specific facts. Analogize and distinguish relevant cases. Address counterarguments.]

   3. Conclusion on this sub-issue: [One sentence.]

B. [Second Sub-Issue]
   [Same IRAC structure]

[Continue for all sub-issues]

V. CONCLUSION

[Restate the overall conclusion. Summarize the key supporting reasons. Note any significant risks, uncertainties, or areas where the law is unsettled. Recommend next steps if appropriate.]

────────────────────────────────────────────────

DISCLAIMER: This memorandum was prepared by an AI legal assistant for informational purposes only. It does not constitute legal advice and should not be relied upon as such. Consult a licensed attorney for advice on your specific situation.
```

## Step 4: Citation Check

Review all citations in the memo:
- [ ] Every legal proposition has a citation
- [ ] Case citations include: party names, reporter/database reference, court, and year
- [ ] Statute citations include: title, code, section number
- [ ] No fabricated citations — if a citation cannot be verified, remove it and note the gap
- [ ] Parenthetical descriptions accurately reflect the cited holding

## Step 5: Deliver

Save the memorandum and present:
- The completed memo
- A list of key authorities relied upon
- Any limitations or gaps in the research (e.g., "could not access [database], recommend verifying [citation]")
- Recommended next steps

## Rules
- NEVER fabricate citations. This is the cardinal rule. An honest "I could not find authority directly on point" is infinitely better than a fake citation.
- Always specify jurisdiction. A memo without jurisdiction context is useless.
- Distinguish between binding and persuasive authority. Note when citing out-of-jurisdiction cases.
- Address counterarguments. A one-sided memo is not useful — the other side will make these arguments.
- If the question is in a gray area, say so. Don't force a definitive answer where the law is genuinely unsettled.
