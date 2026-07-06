---
name: copy-refiner
description: 'Tighten landing-page and product copy — headline, subhead, CTA, feature blurbs — into something a reader actually finishes. Enforces concrete rules on length, voice, and verbs. Use after the artifact has placeholder copy and you want the real thing, or when the user asks you to rewrite copy. Do NOT use for long-form content (essays, blog posts) — copy-refiner is for marketing/UI surfaces.'
trigger: /copy-refiner
---

# Copy Refiner — short, sharp, finished

## Overview

Default agent copy reads like the agent: hedged, polite, jargon-heavy, three adjectives where one would do. This skill replaces it with copy a real reader finishes. The discipline is not "be creative" — it's "remove every word that survives removal."

Use this after a section has placeholder copy ("Discover the power of..."). Use it when the user asks "tighten this." Don't use it for long-form prose — the rules below assume marketing surfaces (landing pages, dashboards, empty states, button labels), not essays.

---

## Critical Constraints

1. **Headline ≤ 7 words.** Subhead ≤ 18. Body block ≤ 3 sentences per paragraph. Button label ≤ 3 words. Hard limits — if you can't hit them, the message is unclear, not the copy.
2. **One benefit per surface.** A hero says ONE thing. Adding "and X, and Y, and Z" dilutes all three. If you have three benefits, you have three sections — not one heroically long sentence.
3. **Verbs over nouns. Imperative over passive.** "Ship faster" not "shipping made faster." "Get the plan" not "Submit". "Start free" not "Sign up". The verb tells the reader what they DO next.
4. **No marketing throat-clearing.** Banned openers: "Discover", "Unlock", "Unleash", "Transform your", "Welcome to the future of", "Powered by", "Built for the modern". Each is a tell that the agent isn't sure what the product does.
5. **Concrete over abstract.** "127 reviewers approved this draft" beats "Loved by reviewers." "$19/month" beats "Affordable plans". "Index 500k pages in 4 minutes" beats "Lightning-fast indexing".
6. **Drop every adjective that survives removal.** Read each sentence twice — once with the adjective, once without. If the sentence still works, the adjective wasn't earning its place.
7. **Voice = audience.** B2B technical buyers want direct, specific, no hyperbole. Consumers want warm, second-person, low-friction. Mismatched voice is the slowest read.

---

## The four surfaces and what each one does

### Surface 1 — Hero

**Headline:** the single benefit, ≤ 7 words. Imperative or declarative. Not a question. Not a metaphor.

Wrong: "Ready to revolutionize your workflow?" (question, vague, throat-clearing).
Wrong: "The future of project management is here." (no benefit, no specifics, hyperbole).
Right: "Ship project plans in an hour" (verb, specific, benefit, 6 words).
Right: "Postgres backups, every 5 minutes" (specific, concrete, declarative, 5 words).

**Subhead:** the proof or the mechanism. ≤ 18 words. One sentence.

Right: "Plain-text plans your team can comment on, version, and ship without rewriting them in three tools."

**Primary CTA:** verb + outcome. ≤ 3 words.

Right: "Start free trial", "Get my plan", "See the demo", "Read the docs".
Wrong: "Submit", "Click here", "Learn more" (vague), "Get started today and unlock your potential" (long, throat-clearing).

**Secondary CTA (text link, not a button):** "See pricing →", "Watch the 90-second tour", "Read how it works".

### Surface 2 — Feature block

**Title:** the verb the feature lets the user do, OR the noun the feature gives them. ≤ 5 words.

Wrong: "Powerful Analytics Dashboard" (adjective + noun chain, generic).
Right: "Track every deploy" (verb + object, specific).
Right: "Diffs across environments" (noun + qualifier, specific).

**Body:** 1-2 sentences. First sentence states what it does. Second states why that matters.

Right: "Every deploy logs its environment, commit, and review. Roll back across 30 days without opening a ticket."

Avoid: third-person product voice ("Our system automatically tracks..."). Avoid: a bulleted feature list inside a feature block — that's three features, not one.

### Surface 3 — Pricing tier

**Tier name:** one word, descriptive of the user not the product. "Solo" / "Team" / "Org". Avoid "Pro" / "Premium" / "Enterprise" (every product uses them, none differentiate).

**Tagline:** one line, describes the user. "For one builder shipping their first product."

**Price line:** the number, the unit, billed-as. "$19 / month, billed annually". Don't hide the annual gotcha.

**Inclusion list:** 4-6 bullets. Each bullet ≤ 6 words. Specifics > features. "5 projects" > "Multiple projects". "Slack + email alerts" > "Notifications".

### Surface 4 — Empty state / Loading / Error

These are the surfaces every product skips and every user remembers.

**Empty state:** what to do next, not "no data yet". "Connect a database to start." "Drop a CSV here, or browse." Action-forward.

**Loading:** never just "Loading…". Either describe what's happening ("Indexing your tables — usually 30s") or skip the label and show a skeleton.

**Error:** what went wrong + what to do. "We couldn't reach your database. Check the connection string in Settings → Connections."

---

## Voice profiles — pick one, hold it for the whole artifact

| Audience | Voice | Example headline | Example CTA |
|----------|-------|------------------|-------------|
| Developers / technical buyers | Direct, specific, no hyperbole, mono numerals OK in body | "Postgres backups, every 5 minutes" | "Read the docs" |
| B2B operators (ops, finance, marketing leads) | Confident, outcome-led, plain English | "Close books 3 days faster" | "Book a demo" |
| Solo founders / indie builders | Warm second-person, specific, low-friction | "Get your landing page live tonight" | "Start free" |
| Consumers | Friendly, second-person, sensory verbs | "Sleep better, starting tonight" | "Try it free" |
| Premium / luxury | Restrained, declarative, no second-person at all | "A pen, considered." | "Order" |

Pick one. Don't mix — "Sleep better, starting tonight. Our enterprise-grade infrastructure..." is two voices fighting.

---

## The eight-step refinement pass

For any piece of copy:

1. **Read it aloud.** If you stumble, the reader does too. The stumble shows the cut.
2. **Strike every adjective.** Read again. Put back only the ones whose absence hurts the meaning.
3. **Replace nouns with verbs.** "The achievement of goals" → "achieve goals". "The deployment of changes" → "deploy changes".
4. **Strike "you can".** Almost always padding. "You can manage your team from here" → "Manage your team from here".
5. **Strike "simply", "easily", "seamlessly".** These are tells, not descriptions. If the thing is simple, the rest of the sentence shows it.
6. **Replace abstract claims with numbers.** "Loved by teams" → "1,200+ teams". "Fast" → "200ms p95". "Affordable" → "$19/month".
7. **Tighten the verb.** "Make it possible to ship" → "Ship". "Helps you to track" → "Tracks".
8. **Count the words.** If the headline > 7 or subhead > 18, the message isn't sharp yet. One more pass.

---

## Concrete examples

### Example 1 — pricing page hero refinement

**Original (placeholder, generic AI default):**

```
Headline: Discover the power of flexible pricing
Subhead: Our innovative platform offers a variety of plans designed to meet the needs of teams of all sizes, helping you unlock your potential and transform your workflow.
CTA: Get Started Today
```

**Audit:**
- Headline: "Discover" — banned opener. "the power of" — empty phrase. "flexible pricing" — no benefit, just product-noun.
- Subhead: 28 words. Contains "innovative", "variety", "designed to meet", "unlock your potential", "transform your workflow" — five tells in one sentence.
- CTA: 3 words but vague — "today" is filler, "Get Started" doesn't say what they start.

**Refined (B2B operator voice, modern-minimal direction):**

```
Headline: Pricing that grows with the team
Subhead: Start free for one user. Add seats as you scale, billed monthly or yearly.
Primary CTA: Start free
Secondary: See plan details →
```

**Why it works:**
- Headline 6 words, declarative, names the benefit (growth) and the audience (the team).
- Subhead 14 words, two sentences, concrete (free / one user / billed monthly or yearly).
- "Start free" is verb + outcome — they know what they get when they click.

### Example 2 — feature block refinement

**Original (placeholder, generic):**

```
Title: Powerful Real-Time Collaboration
Body: Our advanced collaboration features allow team members to work together seamlessly in real-time, with intuitive tools that make it easy for everyone to stay aligned, regardless of their location or time zone.
```

**Audit:**
- Title: "Powerful" + "Real-Time" + "Collaboration" — three adjective-laden nouns, says nothing specific.
- Body: 33 words, three tells ("advanced", "seamlessly", "intuitive"), one filler clause ("regardless of their location or time zone" — every web product does this).

**Refined (B2B SaaS, modern-minimal voice):**

```
Title: Comment without leaving the doc
Body: Highlight a paragraph, leave a note, tag a teammate. Comments thread; resolutions stay searchable.
```

**Why it works:**
- Title 6 words, names the verb (comment) and the constraint it removes (leaving the doc).
- Body 14 words, two sentences. First sentence is three concrete verbs (highlight, leave, tag). Second sentence names two specifics: threading + searchable.
- Zero adjectives. Zero "powerful". Zero "seamlessly".

### Example 3 — empty state

**Original:**

```
No projects yet
```

**Refined (depends on what the user should do):**

For a project-management product: `"Create your first project to plan a sprint, ship a release, or run a launch."` + button "Create project".

For a connector dashboard: `"Connect your first source — Postgres, Stripe, or GitHub — to see live data here."` + button "Connect source".

The refined version tells the user the next action AND gives them concrete examples of WHAT they'd do.

---

## Anti-patterns

- **Don't write "Welcome to [Product]."** Every reader knows where they are. The hero space is for one benefit, not a greeting.
- **Don't list "key features" as bullets in the hero.** The hero promises ONE thing. Bullets belong in feature blocks or pricing tables.
- **Don't use sentence case for product names in copy.** "linear", "stripe", "notion" — these are brands and capitalize as "Linear", "Stripe", "Notion". Inconsistency reads as carelessness.
- **Don't write CTAs like "Click here" or "Learn more".** Both are the verb + zero outcome. If the user has to read the surrounding text to know what happens on click, the CTA failed.
- **Don't write the copy and then write a different copy for the subhead.** The subhead supports the headline; it doesn't restate the headline or pivot to a new claim.
- **Don't ship copy that hasn't been read aloud.** Reading silently is fast and forgiving. Reading aloud catches the stumble — and the stumble is where the cut is.
- **Don't add an exclamation mark.** Two acceptable uses across an entire landing page: a literal "Yes!" and a quoted testimonial that contained one. Otherwise the punctuation is doing emotional work the words couldn't, which means the words need rewriting.
