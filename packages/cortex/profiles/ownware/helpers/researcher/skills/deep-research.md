---
name: deep-research
description: Methodology for answering an open-ended research question across many web sources — decompose, search wide, read deep, triangulate, and synthesize a cited brief. Use when a question can't be settled from one page or a single search.
trigger: /deep-research
allowedTools:
  - web_search
  - web_fetch
  - browser_navigate
  - browser_snapshot
  - browser_evaluate
  - browser_wait
  - readFile
---

# Deep Research Method

The failure mode of a weak researcher is "search once, read the first result, report it as fact." This skill is the disciplined alternative. Follow the phases in order; don't skip to synthesis before you've triangulated.

## Phase 1 — Decompose (before any search)

Write the question down as **3–6 concrete sub-questions**. You are "done" only when each is answered or explicitly marked unanswerable. Example — "research the AI coding-agent market" becomes:
- Who are the main players?
- How does each differ (autonomy, domain, surface)?
- What's the pricing landscape?
- Where is the market gap?

Keep this list. It's your definition of done.

## Phase 2 — Map (breadth)

Run **several angled `web_search` queries**, not one. Vary the phrasing, and deliberately search the *opposite* of your hypothesis:
- the topic itself ("X overview 2025")
- the critical view ("X limitations", "X problems", "criticism of X")
- the alternatives ("X vs", "alternatives to X")

From the results, pick the **3–6 strongest sources** — prefer primary documents (the filing, the paper, the product's own docs) over commentary about them.

## Phase 3 — Read (depth)

`web_fetch` each strong source and read it **in full**. Don't reason from search snippets. When a page is JS-rendered, gated behind interaction, or paginated, switch to the browser: `browser_navigate` then `browser_snapshot` to read it cheaply (`browser_evaluate` to pull structured data like tables/embedded JSON).

Chase every material claim to its **primary source**. A news article about a study is not the study.

## Phase 4 — Triangulate

For each non-trivial claim: confirm it across **at least two independent sources**. Rules:
- One source = a lead, not a fact.
- Sources disagree → say so, name which you trust and why. Never silently pick one.
- Time-sensitive claim (price, version, "latest", leadership, law) → capture the source date and report "as of <date>".
- Can't confirm → mark **UNVERIFIED**. Do not assert it.

## Phase 5 — Synthesize

Answer the original question, bottom line first. Map findings back to the sub-questions from Phase 1 — if any are still open, they go in "Open / unverified", not quietly dropped. Give an honest **confidence** level and say what's solid vs. thin.

Output shape:

```
## Answer            ← bottom line, 2–5 sentences
## Key findings      ← bullets, dated where time-sensitive
## Confidence        ← High/Medium/Low + why
## Open / unverified ← what you couldn't confirm
## Sources           ← [title](url) — what it supported (as of <date>)
```

## Guardrails

- Time-box: ~25 turns. A scoped partial beats an endless hunt.
- Search neutrally — looking only for confirming evidence guarantees you find only it.
- Every material claim in the brief traces to a source in `## Sources`. No exceptions.
