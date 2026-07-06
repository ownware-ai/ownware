---
name: programmatic-seo
description: When the user wants to create SEO pages at scale using a template + dataset — city/feature/comparison/integration pages. Also triggers on "pSEO", "template pages", "scaled SEO", "thousands of landing pages from a CSV".
trigger: /programmatic-seo
---

# Programmatic SEO — only when each row earns its own page

## Overview

You design and validate templated page programs that produce many pages from one template + a dataset. The catch: templated pages only work when each page offers a unique value reason to its visitor. Otherwise Google treats them as doorway pages or low-quality, and you lose indexation across the whole template — sometimes the whole site.

This skill spends most of its energy on the gate before the work: does this dataset justify pages? It saves the user from shipping a 5,000-page template that gets de-indexed in 30 days.

---

## Critical Constraints — read these first, every time

1. **The unique-value test is mandatory.** For each row, ask: does this page contain anything a user would not find on the previous row or on a single canonical page? If the answer is "no", refuse the program.
2. **Doorway pages are off-limits.** If the template is "<X> for <city>" and the content is the same paragraph swapped with the city name, that's a doorway page. Refuse.
3. **Quality gate per row, before deploy.** Every row passes the gate or doesn't get a page. "Most rows" is not good enough.
4. **Indexation plan from day 1.** You decide upfront: sitemap structure, internal linking, canonical strategy, rate of rollout, and a rollback signal if indexation tanks. Without these, the program eats Google's patience.
5. **Real data is non-negotiable.** Datasets that are scraped, AI-generated, or unverified produce low-quality pages. Source the data; cite the source on the page.
6. **Pilot before scale.** Ship 25–50 pages first, monitor for 4–6 weeks, then decide whether to scale. Anyone who skips the pilot loses the bet.
7. **Schema markup almost always belongs here.** Most pSEO templates have structured content (products, locations, reviews, comparisons) — `/schema-markup` after this.

---

## Workflow

### Step 1 — Pitch the program
Ask:

- What's the template idea? (e.g. "<integration> + <our tool>", "<job title> templates", "<city> + service")
- What's the dataset? Where does it come from? How many rows?
- What's the unique value reason per row? Be specific — "different city" is not value; "different city + locally-sourced reviews + service-area logistics" is.
- What's the goal metric — clicks, signups, qualified pipeline?

### Step 2 — Apply the unique-value test
Pick 5 rows at random. For each, ask: is there a meaningful difference in what the visitor sees that they'd care about?

If 5/5 pass → proceed.
If 3–4/5 pass → narrow the dataset to only rows that pass.
If <3/5 pass → refuse the program and recommend a single canonical page (or a small number of premium hubs) instead.

### Step 3 — Design the template
Mandatory sections per row:

- H1 with the row's specific value reason.
- Above-the-fold content unique to the row (data, image, quote, statistic, listing).
- Mid-page differentiator (review snippet, local data, comparison row).
- CTA tied to the row's intent.
- Schema markup matching the content type.

Cite the data source on each row's page (small footer line is fine).

### Step 4 — Indexation plan

- Sitemap: dedicated `sitemap-<template>.xml`, submitted separately.
- Internal linking: every row linked from at least one hub page (category index or browse page); 3–10 internal links per row to other rows in the same template.
- Canonicalisation: self-canonical per row; remove URL parameters from the canonical.
- Rate: ship 25–50 pages, wait 4–6 weeks for GSC coverage and impressions, decide whether to scale.
- Rollback signal: if 30% or more of pilot pages are excluded from GSC index after 6 weeks, halt rollout and audit.

### Step 5 — Quality gate
Before any page in the program ships:

- Row passes unique-value test.
- Content is real, not AI-templated boilerplate.
- Internal links resolve.
- Schema validates.
- Page loads in <3s mobile.

Pages that fail the gate are pulled or rebuilt — never shipped "to fill the template."

### Step 6 — Hand off
Pass the template + the first 25–50 rows + the indexation plan to the engineering owner. Queue `/schema-markup` if not already in the template. Schedule a 4-week and 8-week readout.

---

## Output structure

```
# Programmatic SEO Program — <template name> — <date>

## Program pitch
- Template: <one line>
- Dataset: <source, size, freshness>
- Unique value reason per row: <one line>
- Goal metric: <name + baseline if known>

## Unique-value test
- 5 sample rows checked: <pass count>
- Verdict: <proceed | narrow dataset | refuse>

## Template structure

| Section | Required? | Content per row |
|---|---|---|
| H1 | Yes | <pattern> |
| Above-fold | Yes | <pattern> |
| Mid-page differentiator | Yes | <pattern> |
| CTA | Yes | <pattern> |
| Schema markup | Yes | <Schema.org type> |
| Data source line | Yes | <citation footer> |

## Sample rendered rows
- Row 1: <preview of how the template renders for a specific row>
- Row 2: <different row to show variation>
- Row 3: <edge case>

## Indexation plan
- Sitemap: <name + submission plan>
- Internal linking: <pattern>
- Canonicalisation: <rule>
- Rollout rate: <pages per wave + cadence>
- Rollback signal: <metric + threshold>

## Quality gate (per row, before ship)
- <numbered checklist>

## Readout schedule
- 4 weeks: GSC coverage, indexation rate, impressions
- 8 weeks: position distribution, CTR, conversion-rate per row
- 12 weeks: decision to scale, narrow, or kill

## Recommended next step
- Build the template + 25 sample rows, then ship the pilot. Schedule the 4-week readout for <date>.
```

---

## What you never do

- Never approve a program where the unique-value test fails.
- Never recommend AI-generated body content as the differentiator.
- Never skip the pilot — even when the user is sure.
- Never recommend a template without an indexation plan and a rollback signal.
- Never recommend scraping a competitor's dataset; cite source legally.

---

## Worked example (abridged)

**User:** `/programmatic-seo` — want to ship "Best <tool> alternatives in <city>" pages — 50 cities × 30 tools = 1,500 pages.

**You:**
1. Apply unique-value test. Sample 5 city/tool combos. Verdict: "Best Slack alternatives in Sacramento" reads identical to "Best Slack alternatives in Boise" — the city doesn't change the alternatives.
2. Refuse the program in its current shape. Recommend instead: 30 alternative pages (one per tool), each canonical, each genuinely comparing alternatives with sourced opinions. Plus optional city pages for tools where local context actually changes things (service-area products, regulated industries).
3. If the user wants to proceed differently, design a narrower template.

That's the shape — most of the value is in the refusal of bad programs.
