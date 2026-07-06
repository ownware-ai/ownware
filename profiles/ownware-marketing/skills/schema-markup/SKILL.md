---
name: schema-markup
description: When the user wants to add, fix, or optimise structured data on a page or template. JSON-LD by default. Schema.org-valid. Also triggers on "structured data", "FAQ schema", "rich results", "Schema.org", "Product schema".
trigger: /schema-markup
---

# Schema Markup — structural, not decorative

## Overview

You produce JSON-LD schema markup that matches what's actually on the page. Schema is structural: it tells search engines what each piece of content IS. It is not a decoration to chase rich-results badges. Adding FAQ schema to a page with no FAQ is a path to a manual action, not better rankings.

The output is one or more JSON-LD snippets ready to paste into the page head, plus a validation note and a checklist for the engineering owner.

---

## Critical Constraints — read these first, every time

1. **Schema describes what's there, not what you wish was there.** If the page has no FAQ, there's no FAQ schema. If the page has no reviews, there's no Review schema.
2. **Schema.org valid.** Every property either matches the schema.org definition or is removed. Made-up properties don't render.
3. **JSON-LD by default.** Microdata and RDFa are legacy; recommend JSON-LD unless the user has a specific reason.
4. **One source of truth per entity.** A product page has one `Product`, not three competing `Product` blocks. Conflicting schema kills rich results.
5. **Currency, dates, and URLs are absolute.** No `USD500` — `"price": "500.00", "priceCurrency": "USD"`. No relative URLs — full `https://...`.
6. **No schema for manipulating search.** No fake review schema, no fake aggregateRating, no hiding `inLanguage` to game results. These are manual-action triggers.
7. **Validate before shipping.** Use Google's Rich Results test and Schema.org validator. Note the validator results in the output.

---

## Schema type cheat sheet

Pick the type that matches the page's primary content. Most pages need exactly one primary type plus `BreadcrumbList`.

| Page kind | Primary type | Notes |
|---|---|---|
| Marketing homepage | `Organization` + `WebSite` (search action) | One `Organization` per site, not per page |
| Pricing | `Product` with `Offer` per tier | Don't fake reviews |
| Blog post / article | `Article` (or `BlogPosting`) | `author`, `datePublished`, `headline` mandatory |
| Product / feature page | `Product` or `SoftwareApplication` | `applicationCategory`, `offers`, `aggregateRating` only if real |
| How-to / tutorial | `HowTo` | `step`, `tool`, `supply`, `totalTime` |
| FAQ page (real FAQs) | `FAQPage` | Each `Question` must appear on the page in matching text |
| Recipe | `Recipe` | Quantities, time, nutrition |
| Event | `Event` | `startDate`, `endDate`, `location`, `eventStatus` |
| Local business / location | `LocalBusiness` (or specific subtype) | NAP + opening hours |
| Comparison / vs page | `Article` + product references | Don't claim a single `Product` for a comparison |
| Breadcrumbs (every deep page) | `BreadcrumbList` | Pair with the primary type |

---

## Workflow

### Step 1 — Identify the page and its primary content
Read the page (or get the user to paste the HTML / URL). Identify:

- The primary content type (matched against the cheat sheet).
- What's actually present that schema can describe (headings, lists, FAQ items, products, prices, reviews).
- What's NOT present (so you don't add schema for it).

### Step 2 — Pick the type and the required properties
For each type, Schema.org lists required + recommended properties. Required ones must be filled with real data; recommended ones are filled where the content supports it.

### Step 3 — Draft the JSON-LD
Use the absolute URL form. Use ISO dates. Use exact currency codes. One block per entity.

For pages with multiple types: stack them in the same `<script type="application/ld+json">` block as an array, OR use multiple script blocks — both work; pick one and be consistent across the site.

### Step 4 — Validate
- Schema.org validator: pass.
- Google Rich Results test: pass for any type that supports rich results (Article, Product, FAQPage, HowTo, Recipe, Event, Breadcrumb).
- If a property is missing for a rich result but it's not in your data, leave it out and note that the rich result will not render.

### Step 5 — Hand off
Pass the JSON-LD to the engineering owner with placement instructions (head of the page, server-rendered, not client-injected — Google can read either but server-rendered is the safer default).

---

## Output structure

```
# Schema Markup — <page> — <date>

## Page
- URL: <full>
- Primary content type: <e.g. pricing page with three tiers + real FAQ>
- What's present that schema describes: <bullets>
- What's NOT present (so no schema for): <bullets>

## Schema (JSON-LD)

```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "...",
  "description": "...",
  "image": "https://...",
  "brand": {
    "@type": "Brand",
    "name": "..."
  },
  "offers": [
    {
      "@type": "Offer",
      "name": "Starter",
      "price": "29.00",
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://..."
    }
  ]
}
```

(Plus `BreadcrumbList` if relevant.)

## Validation
- Schema.org validator: <pass / errors listed>
- Google Rich Results test: <pass for which result types>
- Properties missing for rich result rendering: <list>

## Placement instructions for engineering
- Server-rendered in `<head>` of the page.
- One block per entity, or array under one block — consistent across site.
- Re-validate after deploy.

## Recommended next step
- Ship; re-test in Rich Results after deploy. Schedule a 30-day check for rich-result impressions in GSC.
```

---

## What you never do

- Never add `aggregateRating` without real, sourced reviews.
- Never add FAQ schema to a page without visible FAQ matching the schema text.
- Never use `Review` schema for marketing copy.
- Never invent properties that don't exist on schema.org.
- Never ship schema without running both validators.
- Never recommend a schema type the page's content doesn't support — refuse and explain.

---

## Worked example (abridged)

**User:** `/schema-markup` — pricing page with three tiers and a real FAQ section at the bottom.

**You:**
1. Identify: `Product` for the product + `Offer` per tier + `FAQPage` for the FAQ + `BreadcrumbList` for navigation.
2. Build JSON-LD with three offers, three FAQ Q&A pairs (each appearing verbatim in the page text — verified).
3. Validate both: pass.
4. Output the JSON-LD block + placement instructions for engineering.
5. Note: rich result render likely for Product offers and FAQ Q&A; possibly breadcrumb in mobile results.

That's the shape. Match the schema to what's on the page, never inflate.
