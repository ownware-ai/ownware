---
name: marketing-context
description: Bootstrap the shared product-marketing context document at `.claude/product-marketing-context.md`. Run this once per project. Every other marketing skill reads it before asking the user redundant questions. Also triggers on "set up marketing context", "bootstrap product context", "create marketing brief doc".
trigger: /marketing-context
---

# Marketing Context — bootstrap the one-time doc

## Overview

This skill creates `.claude/product-marketing-context.md` in the working directory. The file is the shared briefing every other marketing skill reads first — so the user doesn't re-explain ICP, JTBD, positioning, and voice on every call. Run it once at the start of work with a new product; update it when the product, audience, or positioning genuinely shifts.

The output is a structured markdown file the user reviews and edits. The skill does not fabricate the content — it interviews the user (and pulls audience evidence) to fill the doc honestly.

---

## Critical Constraints — read these first, every time

1. **One file per project.** `.claude/product-marketing-context.md` is canonical. Do not create variants. If one exists, default to UPDATE, not overwrite.
2. **No fabrication.** Every field is filled with what the user knows (or what `audience-researcher` surfaces from real sources). Empty fields are labelled `[unknown — to fill]` — not invented.
3. **Sourced where possible.** ICP claims, JTBD claims, positioning anchors — cite the source for each (review, customer quote, internal doc).
4. **Plain language.** No "category-defining", "market-leading", "best-in-class". The context doc has to be useful for downstream skills, not a marketing pitch.
5. **Assumptions are labelled.** Anything the user is guessing about — label `Assumption:` with a way to validate. The doc surfaces what we know vs. what we're betting on.
6. **Keep it short.** 200–500 lines, max. Beyond that the doc becomes a place nobody updates.
7. **The doc evolves.** End with a `## Open assumptions` and `## Recent changes` block so the user remembers to keep it fresh.

---

## Sections of the doc

The skill produces a file with exactly these top-level sections. Order matters — downstream skills look for them.

1. **Product** — what it is, who built it, current stage.
2. **ICP** — the ideal customer profile(s), with characteristics and sources.
3. **JTBD** — the jobs the product is hired for, sourced from VOC.
4. **Positioning** — the one-line positioning + the most-likely alternative customers consider.
5. **Voice** — do say, don't say, banned phrases, tone reference.
6. **Canonical metrics** — the metrics this team measures, and where they live.
7. **Brand do-not-do** — things this brand has decided not to do.
8. **Open assumptions** — labelled `Assumption:` items needing validation.
9. **Recent changes** — dated log of changes to this doc.

---

## Workflow

### Step 1 — Check for existing file
If `.claude/product-marketing-context.md` already exists, READ it. Confirm with user: refresh entirely, edit specific sections, or add a recent-change entry.

### Step 2 — Interview for each section
For each section, ask the user the relevant questions. Where the answer would benefit from audience evidence (ICP, JTBD, voice), call `audience-researcher`.

**Product:**
- One-paragraph description.
- Current stage (alpha / beta / GA / mature).
- Who built it (team size, founder context only if relevant).

**ICP:**
- Primary segment — title, company size, industry if relevant.
- What characterises a fit customer (firmographic + behavioural).
- What disqualifies (the wrong fits we keep seeing).
- Sources: closed-won deals, sales feedback, retention data.

**JTBD:**
- What jobs is the product hired for?
- What jobs is it NOT for (so we stop trying)?
- Source the jobs from VOC quotes where possible.

**Positioning:**
- For <ICP>, <product> is the <category> that <benefit + mechanism>, unlike <alternative> which <limitation>.
- What's the most-common alternative the customer is choosing between (could be a competitor, could be "doing nothing", could be a spreadsheet).

**Voice:**
- Do say: <list of phrases / framings>.
- Don't say: <banned phrases, jargon, claims>.
- Tone reference: someone the brand sounds like, or a description (warm-and-direct, technical-and-precise, dry-and-witty).
- Reading level / audience expectation.

**Canonical metrics:**
- What metrics the team optimises for.
- Where each metric lives (GA4 / Mixpanel / Stripe / data warehouse).
- Definition for each (e.g. "activation = first feature_used event within 7 days of signup").

**Brand do-not-do:**
- Patterns the brand has decided against (e.g. no fake scarcity, no influencer marketing, no growth hacking).
- Claims that are off-limits (legal / regulatory / brand-voice reasons).

**Open assumptions:**
- Anything the user is guessing about — `Assumption: <claim>. Validate by: <how>.`

### Step 3 — Draft the file via `asset-author`
Hand the structured content to `asset-author` with the path `./.claude/product-marketing-context.md`.

### Step 4 — Confirm with the user
Show the saved file. Walk the user through each section. Have them edit any drift between what they said and what was captured.

### Step 5 — Recommend cadence
- Re-read this doc at the start of any new marketing project.
- Update when: product changes, ICP narrows or broadens, positioning shifts, the team learns something material about the audience.
- Audit every quarter even if nothing has obviously changed.

---

## Output structure

The file written to disk:

```
# Product Marketing Context — <date>

## Product
<one paragraph: what it is, who built it, current stage>

## ICP

### Primary segment
- Title / role: <e.g. SRE / DevOps lead>
- Company size: <e.g. 100–1,000 engineers>
- Industry: <or "horizontal">
- Behavioural signal: <e.g. "actively running Datadog / NewRelic / Honeycomb">

### Disqualifying signals
- <bullets>

### Sources
- <closed-won data, sales feedback, retention pattern — sourced>

## JTBD

| Job | Source |
|---|---|
| Reduce observability bill volatility | r/devops, 6 threads; G2 reviews, 8 mentions |
| Cut time-to-detection on production incidents | Sales calls, 12 transcripts |
| ... | ... |

## Positioning
For <ICP>, <product> is the <category> that <benefit + mechanism>, unlike <alternative> which <limitation>.

Most-common alternative: <one — could be a competitor or "doing nothing">.

## Voice
- Do say: <bullets>
- Don't say: <bullets>
- Tone reference: <one line>
- Reading level: <one line>

## Canonical metrics

| Metric | Definition | Lives in |
|---|---|---|
| Activation | First feature_used event within 7 days of signup | Mixpanel |
| MRR | Net monthly recurring revenue | Stripe |
| Organic CTR | clicks / impressions for non-branded queries | Search Console |

## Brand do-not-do
- <bullets>

## Open assumptions
- `Assumption:` <claim> — Validate by: <how>
- ...

## Recent changes
- 2026-05-11 — Initial version of this doc.
```

The skill's response (in chat) confirms:

```
Saved product marketing context to ./.claude/product-marketing-context.md.
- Sections filled: 7 of 8 (Brand do-not-do empty — followup recommended)
- Sourced claims: 14
- Open assumptions flagged: 4

## Recommended next step
- Walk the user through each section. Re-read this doc at the start of any new marketing skill call. Audit quarterly.
```

---

## What you never do

- Never invent ICP characteristics, JTBD jobs, customer logos, or positioning claims.
- Never overwrite an existing context doc without asking.
- Never fill in `Voice / banned phrases` from your own taste; only from what the user states.
- Never let the doc grow past ~500 lines. Trim.
- Never skip the `Open assumptions` section — that's where the unknowns get tracked.

---

## Worked example (abridged)

**User:** `/marketing-context` — fresh project, B2B observability product.

**You:**
1. No existing file. Confirm fresh creation.
2. Interview the user on Product, ICP, JTBD, positioning, voice, metrics, brand do-not-do.
3. For ICP and JTBD, run `audience-researcher` to surface real sources.
4. User answers some sections fully, leaves Brand do-not-do thin (only "no fake scarcity"); flag for followup.
5. Hand to `asset-author`; saves to `./.claude/product-marketing-context.md`.
6. Walk through each section with the user.
7. Recommend quarterly audit.

That's the shape. The doc earns its place by making every later skill ~30% faster.
