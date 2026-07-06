---
name: teaser
description: Draft an anonymous one-page company teaser — distributed to broad universe of potential buyers BEFORE NDA, designed to spark interest and qualify recipients. Use when the user asks for a teaser, blind one-pager, no-name profile, or pre-NDA marketing piece. Strict anonymisation discipline; this goes to dozens or hundreds of recipients.
trigger: /teaser
---

# Teaser — Anonymous One-Page Profile

## Overview

A single-page anonymised profile distributed pre-NDA to a wide universe of qualified buyers. Designed to (a) describe the opportunity in enough detail to spark interest and (b) qualify recipients without revealing identity. Broader distribution than the CIM, so anonymisation discipline is even tighter.

---

## Critical Constraints — read these first, every time

1. **One page. Exactly.** If content overruns, cut. Don't shrink the font. Don't double-side. One side, one page.
2. **Anonymisation is total.** No company name, no founder names, no customer names, no city-specific addresses. Codename only.
3. **The teaser cannot reveal identity by description alone.** "AI-native vertical SaaS for veterinary clinics with > 4,000 customers in North America" → check that this description doesn't uniquely identify the company in a market with 2 such providers. If it would, generalize.
4. **Headline metrics, anonymised.** Revenue ranges, growth ranges, margin ranges. Not point numbers when point numbers reveal identity.
5. **Cite the source basis** in a footnote even if specific numbers are ranged. Reader knows the basis is FY24 audited / management Q1 FY26 dashboard / etc.
6. **Process / next-step is clear.** "Sign NDA via [link / contact] for further information" or "Indications of interest by <date>."
7. **Distribution context.** Will this go to 100 buyers? 500? Anonymisation tightness scales with distribution.

---

## Workflow

### Step 1 — Confirm scope
- Codename (project name, not company-derived)
- Distribution count (handful → dozens → hundreds)
- Anonymisation tightness — tighter for broad distribution
- Process type and timing
- Advisor contact for inbound interest

### Step 2 — Pull operational data, ranged
- Revenue: range or rounded ("$200–$250mm LTM")
- Growth: range ("+18-22% YoY")
- Margins: range ("Adj. EBITDA margins in the high-20s%")
- Customer count: range ("2,000+ enterprise accounts")
- Geographic mix: ("Primarily North America with growing EU presence")

If point numbers wouldn't reveal identity, you can use them; otherwise range.

### Step 3 — Build the page
Use the structure in *Output shape*. One page, four blocks: Header, Highlights, Financial snapshot, Process.

### Step 4 — Anonymisation audit
Read the page imagining you're trying to identify the company from the description alone. If you can, generalize. Specifically check:
- Does the customer-segment description uniquely identify? ("agentic AI for autonomous-vehicle middleware" might leave only one or two candidates)
- Does the geographic description reveal? ("HQ in Boulder, Colorado" + "150-person team" probably leaks)
- Do specific KPIs identify? (some KPIs are widely-disclosed and unique)

### Step 5 — Generate the file via `/pdf`

Hand off to the `/pdf` skill (write mode). Specify:

- File: `<Codename>_Teaser_<YYYYMMDD>.pdf` (e.g. `Project_Atlas_Teaser_20260507.pdf`).
- Single page; US Letter, 0.75" margins. Aspect-ratio decisions live in the `/pdf` skill's page template.
- Header: codename in navy on the left, `STRICTLY CONFIDENTIAL` in red bold on the right (via the `onPage` callback so it applies regardless of build path).
- Footer: `Page 1 of 1` centred; `Source: <data sources>; Project advisor` line at the bottom.
- Layout: title block (codename + tag-line), Highlights block (3–4 bullets), Financials snapshot table (3 historical years; numeric columns right-aligned, header row navy with white text), Process block (next steps + advisor contact).
- **Anonymisation verify pass is non-negotiable for teaser-class output.** Before claiming the file is delivered, the `/pdf` skill walks the rendered PDF text and asserts the real company name does not appear on any page. A leak ends the build and surfaces to the user.

If `/pdf` reports a missing-Python error, surface its install instruction and stop. The deliverable is the `.pdf`; an ASCII teaser is not a substitute.

### Step 6 — Run **Final Output Checklist**

---

<correct_patterns>

### One-page teaser layout (markdown approximation of a single PDF page)

```
─────────────────────────────────────────────────────────────────
                          PROJECT ATLAS
            Vertical SaaS Platform | Confidential Teaser
─────────────────────────────────────────────────────────────────

THE OPPORTUNITY

A leading vertical-SaaS platform serving the [INDUSTRY] sector with
mission-critical workflow software, achieving exceptional retention
and high-margin recurring revenue. Strong organic growth runway
across new logo, expansion within existing accounts, and adjacent
products.

KEY HIGHLIGHTS

  •  $200-$250mm LTM revenue, growing in the high-teens YoY
  •  Subscription revenue >70% of total, with NRR of >115%
  •  Mid-70s% gross margins; high-20s% adjusted EBITDA margins
  •  2,000+ enterprise customers; top-10 customer concentration <40%
  •  Founder-led management team; 100+ FTEs

FINANCIAL SNAPSHOT

  Revenue (LTM):        $200-$250mm
  Growth (LTM YoY):     High teens
  Adj. EBITDA Margin:   High 20s%
  ARR:                  $180-$220mm

PROCESS

  • First-round indications of interest due [DATE]
  • Indications by email to [contact@advisor.com]
  • Following IOIs, qualified buyers will receive the CIM under NDA
  • Management presentations: [WINDOW]
  • Expected close: [Q4 2026]

─────────────────────────────────────────────────────────────────
[Advisor name and contact info]
This document is confidential and proprietary. No distribution.
─────────────────────────────────────────────────────────────────

Source basis: ranged metrics derived from audited FY24 financials
and management dashboard as of Q1 FY26.
```

One screen. Codename. Ranged metrics. Process clear. Anonymisation maintained.

### Anonymisation pre-check

Before sending, ask:
1. Does the industry + size + geography combination leave > 5 plausible candidates?
2. Are any KPIs uniquely-identifying (e.g., "operates 47 retail stores in California")?
3. Does the founder / management description reveal? ("Female founder with prior exit to Microsoft" might have N=1)
4. Do the financial ranges leak (e.g., a 92% gross margin with 200+ employees in software is identifiable to a small set)?

If any "yes" → generalize until "no."

</correct_patterns>

<common_mistakes>

### WRONG: Identifying customer description

```
"Mission-critical workflow platform for top US auto manufacturers"
```

There are five US auto OEMs. "Mission-critical workflow platform with concentration in industrial OEMs" is more anonymous.

### WRONG: Point metrics that leak

```
"Revenue: $237mm"
"Customers: 2,847"
```

Specific enough to identify. Use ranges: "$200-$250mm" / "2,500+ customers."

### WRONG: Multi-page teaser

```
[Page 1: Cover, executive summary]
[Page 2: Business overview]
[Page 3: Financial details]
```

That's an executive summary, not a teaser. Teaser = ONE page. Multi-page anonymised material is a CIM.

### WRONG: No process / next-step

```
"For more information, please contact us."
```

Vague. Replace with: "First-round IOIs by [DATE]; submit to [contact]; CIM follows under NDA."

### WRONG: Founder identifiers

```
"Founder is a former senior executive at Google, with 20 years of fintech experience..."
```

Too specific. Even without the name, "former Google + 20 years fintech" narrows to dozens of people, and the company they're now running is identifiable. Generalize: "Founder-led team with prior senior leadership at large-cap technology incumbents."

### TOP 5 ERRORS

1. Identifying industry-customer combination
2. Point metrics that uniquely identify
3. Multi-page document instead of single page
4. Vague process / no next-step / no contact
5. Founder description specific enough to identify the person

</common_mistakes>

---

## Quality Rubric

Every teaser must maximise for:

1. **One page, no exceptions** — fits on a single side.
2. **Total anonymisation** — passes the "could I identify the company from this alone" test.
3. **Ranged metrics** when point metrics would reveal identity.
4. **Clear process** — bid date, contact, CIM trigger.
5. **Source basis cited in footnote** even when numbers are ranged.
6. **Sparks interest without revealing identity** — describes opportunity in functional terms.

---

## Final Output Checklist

- [ ] `.pdf` file generated via `/pdf` and saved at the expected path. File name matches `<Codename>_Teaser_<YYYYMMDD>.pdf`.
- [ ] `/pdf`'s anonymisation verify pass fired and confirmed no real-name leak across any rendered page.
- [ ] Single page, no overruns.
- [ ] Codename + date + "Confidential" header.
- [ ] No company name, founder names, customer names, or city-specific addresses.
- [ ] Industry + size + geography combination cannot uniquely identify.
- [ ] KPIs and metrics ranged where specifics would reveal.
- [ ] 4–6 highlight bullets, each functional / operational.
- [ ] Financial snapshot — revenue, growth, margin, ARR (or relevant equivalents) all ranged.
- [ ] Process block with bid date, contact, CIM trigger, expected close.
- [ ] Source-basis footnote.
- [ ] Anonymisation audit run before release.
- [ ] No advisor opinion / endorsement.
