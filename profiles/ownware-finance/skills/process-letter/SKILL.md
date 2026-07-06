---
name: process-letter
description: Draft an auction process letter — formal communication from the seller's advisor to qualified bidders specifying first-round bid format, content, and timing. Use when the user asks for a process letter, bid procedures letter, or instruction-to-bidders document. Sent under cover by the advisor following NDA execution and CIM distribution.
trigger: /process-letter
---

# Process Letter — Bid Procedures

## Overview

A formal letter from the seller's advisor to qualified bidders specifying:
1. The form, content, and deadline of the first-round bid
2. The information that must accompany the bid
3. The next-stage process if the bidder advances

Tone is precise and businesslike. Bidders treat the letter as the contract for participation; vagueness creates friction.

---

## Critical Constraints — read these first, every time

1. **Specificity is the discipline.** Bid by 5pm ET on a specific date. Send to a specific email. Format: PDF or DOCX, no others. Page limit X. The bidder knows exactly how to comply.
2. **No commitment from seller.** The letter must explicitly state the seller's right to amend, terminate, or accept any bid (or none) at its sole discretion.
3. **Confidentiality reaffirmed.** All materials remain seller's property. NDA continues. No disclosure of process to third parties.
4. **No advisor warranty.** The advisor disclaims warranty of accuracy on any data provided. Bidders rely on their own diligence.
5. **Equal-treatment language.** All qualified bidders receive the same letter, the same data room access, and the same management presentation cadence (process integrity).
6. **Required bid components specified.** Price + structure + financing + due-diligence requirements + closing conditions + management retention.
7. **Verify with the user** — bid date, content requirements, contact details — before drafting.

---

## Workflow

### Step 1 — Confirm scope
- Project codename
- First-round bid deadline (date + time + time zone)
- Submission method (email + recipient)
- Submission format (PDF? DOCX? page limit?)
- Required bid components
- Q&A deadline (typically 2-3 days before bid)
- Process timeline (Q&A → bid → second-round → MP → final → close)

### Step 2 — Confirm legal language
The seller's counsel typically reviews; in absence, use industry-standard "no commitment" language and reaffirm NDA terms. Surface this dependency to the user.

### Step 3 — Draft the letter
Use the section template in *Output shape*. The letter is typically 2-4 pages. Tone: clear, precise, no marketing language.

### Step 4 — Generate the file via `/docx`

Hand off to `/docx`. Specify:

- File: `<Project>_ProcessLetter_<YYYYMMDD>.docx` (e.g. `Project_Atlas_ProcessLetter_20260507.docx`).
- Cover page: target name (or codename if pre-NDA distribution), "Project <Name> — Process Letter," month/year, advisor firm + contact.
- TOC field after the cover (auto-populates on Word open).
- Heading discipline: H1 for top-level sections (Introduction, Process Overview, Bid Requirements, Timeline, Conditions, Disclaimers), H2 for sub-sections. Built-in styles only — no bold paragraphs masquerading as headings.
- Tables for the timeline grid (`Light Grid Accent 1` style; date columns right-aligned).
- Different first-page header/footer enabled — cover has no page number; body pages carry the project name in the header and a `Page X of Y` footer.
- The "no-commitment / seller-discretion" section is mandatory — surface to the user if the parent skill omitted it before generating.

If `/docx` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.docx`; this is a formal counterparty document, not a chat message.

### Step 5 — Final Output Checklist

---

<correct_patterns>

### Process letter structure (illustrative)

```
[Advisor letterhead]

[Date]

Dear [Bidder name],

PROJECT [CODENAME] — FIRST-ROUND BID PROCEDURES

[Advisor] has been retained by [Seller / "the Seller"] (the "Company") in
connection with a potential transaction involving the Company. We invite
your firm to submit a non-binding indication of interest (the "First-Round
Bid") in accordance with the procedures described below.

1. FIRST-ROUND BID SUBMISSION

   (a) Format: a single PDF document, no longer than 10 pages.
   (b) Recipient: [advisor.email@firm.com], cc: [back-up.email@firm.com]
   (c) Deadline: 5:00 p.m. ET on [date].
   (d) Receipt confirmation: We will acknowledge receipt within 24 hours.

2. REQUIRED BID CONTENT

   Each First-Round Bid must address:

   (a) Indicative valuation: enterprise value or equity value, in U.S.
       dollars, expressed as a range or point estimate.
   (b) Form of consideration: cash, stock, mix; if mix, the split.
   (c) Source of funding: equity certain, debt commitments (specify
       arranger if applicable), or pending raise.
   (d) Conditions: regulatory (HSR / antitrust / CFIUS), financing,
       due-diligence, board, shareholder.
   (e) Required diligence to be completed before signing: workstream
       list with estimated duration.
   (f) Anticipated time to signing from selection.
   (g) Management retention philosophy.
   (h) Treatment of customer / employee continuity.

   Bids that omit components (a)-(e) may be deemed non-conforming.

3. PROCESS TIMELINE

   Q&A submission deadline: [date]
   Q&A responses circulated: [date]
   First-round bid deadline: [date]
   Selected bidders advance to second round: [date window]
   Management presentations: [date window]
   Final-round bid deadline: [date]
   Targeted signing: [date window]

4. DUE DILIGENCE

   (a) Data room: [provider]; access granted upon execution of additional
       NDA Schedule [X]. Access continues throughout the second round.
   (b) Diligence calls: scheduled by [advisor] at request.
   (c) Site visits: post-MP only, by mutual scheduling.
   (d) Specialist diligence (legal, accounting, commercial): coordinated
       through [advisor].

5. NO COMMITMENT; SELLER DISCRETION

   This letter and any subsequent communications do not constitute an
   offer, agreement, or commitment of any kind. The Seller reserves the
   absolute right, at its sole discretion, to: amend or modify this
   process at any time; reject any or all bids; accept any bid (whether
   highest-priced or otherwise); negotiate exclusively with one or more
   parties; terminate the process; or withdraw the Company from sale.

6. CONFIDENTIALITY

   All information disclosed in connection with this process remains
   confidential and subject to the Confidentiality Agreement executed
   between [Bidder] and [Advisor / Seller] dated [date]. No bidder may
   disclose participation in this process to any third party without
   prior written consent.

7. ADVISOR DISCLAIMER

   [Advisor] makes no representation or warranty as to the accuracy or
   completeness of any information provided. Bidders rely solely on
   their own diligence in formulating bids.

8. CONTACT

   Questions on the process: [advisor.contact@firm.com]
   Q&A submissions: [data-room Q&A module]

We look forward to receiving your First-Round Bid.

Sincerely,

[Advisor lead banker]
[Title]
[Firm]
```

Specific dates, specific recipients, specific format requirements. No commitment language explicit. Confidentiality and advisor disclaimer present.

</correct_patterns>

<common_mistakes>

### WRONG: Vague timeline

```
"First-round bids by mid-month."
"Second round to follow shortly."
```

Bidders need exact dates and times. Specify: "5:00 p.m. ET on Friday, June 6, 2026."

### WRONG: Required content list incomplete

```
"Submit your indicative price."
```

A first-round bid is more than a price. Specify form of consideration, source of funding, conditions, diligence requirements, time to sign, retention, continuity. Without this, bids come in non-comparably.

### WRONG: Missing no-commitment language

```
[no Section 5 — seller's discretion / no offer]
```

Without explicit "Seller reserves the right to amend / reject / terminate / accept any bid in its sole discretion" language, bidders may argue the letter created an obligation. Always include.

### WRONG: Process secrecy / confidentiality not reaffirmed

```
[no Section 6 — confidentiality continuing]
```

The NDA covers data; the process letter must reaffirm it covers the existence of the process itself. Bidders cannot disclose participation to third parties.

### WRONG: Advisor warrants accuracy

```
"Information provided herein is accurate to the best of our knowledge..."
```

Don't. The advisor disclaims warranty; bidders rely on their own diligence. Otherwise the advisor takes on representation risk.

### TOP 5 ERRORS

1. Vague timeline — bidders can't plan against ranges
2. Incomplete required-content list — bids come in non-comparably
3. Missing no-commitment / seller-discretion language
4. Confidentiality continuation not reaffirmed
5. Advisor warrants accuracy (representation risk)

</common_mistakes>

---

## Quality Rubric

Every process letter must maximise for:

1. **Specific dates and recipients** — bidders know exactly how and when to comply.
2. **Complete required-content list** — comparable bids across all bidders.
3. **No-commitment / seller-discretion** language explicit.
4. **Confidentiality reaffirmed** for the process itself.
5. **Advisor disclaimer** of warranty.
6. **Equal-treatment** in distribution and process integrity.

---

## Final Output Checklist

- [ ] `.docx` file generated via `/docx` and saved at the expected path. File name matches `<Project>_ProcessLetter_<YYYYMMDD>.docx`.
- [ ] Heading styles applied (Heading 1 / Heading 2 — not bold paragraphs); TOC field present.
- [ ] First-round bid deadline: date + time + time zone explicit.
- [ ] Submission method: email + recipient + cc + format + page limit.
- [ ] Required bid content list — at minimum: price, structure, financing, conditions, diligence, time-to-sign, retention.
- [ ] Process timeline — Q&A → first-round → second-round → MP → final → close, all dated.
- [ ] No-commitment / seller-discretion section present.
- [ ] Confidentiality reaffirmed (including secrecy of process participation).
- [ ] Advisor disclaimer of warranty present.
- [ ] Contact details — process questions vs Q&A submissions distinguished.
- [ ] Letter sent equally to all qualified bidders (process integrity).
- [ ] Reviewed by seller's counsel before release (or flagged as dependency).
