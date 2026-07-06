---
name: faq-design
description: FAQ page or pricing-page FAQ block — accordion list, optional search and category filters, real questions phrased in the user's voice. Use when the brief is "FAQ page", "help center index", "pricing-page FAQ block", or "answer the top objections". Skip for long-form docs (use article-layout) or for one-page marketing copy (use artifact + web-guidelines).
trigger: /faq-design
---

# FAQ Design — answer the question the user actually asks

## Overview

The FAQ is the cheapest, highest-ROI surface a product has. It catches the objections that block conversion, the operational questions that flood support, and the trust signals nobody asks for but everyone reads. The discipline is not in the layout (accordions are easy); it is in the COPY: questions phrased the way the user would phrase them, answers in three sentences or fewer, with a link to the long-form for anyone who wants depth.

This skill ships either a full standalone FAQ page (`/faq` route) or a pricing-page FAQ section (5–8 questions below the tiers). Same component, different scope.

For the deeper persuasion moves around objections — anchoring, loss aversion, framing — lean on `/psychology-applied`. For tightening the answer copy itself, lean on `/copy-refiner`. This skill owns the structure and the question selection.

---

## Critical Constraints — read these first, every time

1. **Question phrased as the user would ask it, not as marketing would.** "Can I cancel anytime?" not "What is your cancellation policy?". "Will my data be safe?" not "Tell me about your security posture." Read the question aloud — if it sounds like a customer typing into search, ship it; if it sounds like a press release, rewrite.
2. **Answer in ≤ 3 sentences. Two is better.** If the answer needs four sentences, the next move is a link to the docs (`Read the full security overview →`). The FAQ is a triage layer, not a manual.
3. **Cap on questions: 5–8 in a pricing-page block, 12–20 on a standalone FAQ page.** More than 20 questions on one page and the search bar becomes mandatory; categories become mandatory; the FAQ has become a help-center index and wants a different structure (linked sub-pages).
4. **Accordion default state matters.** All-collapsed when the user is browsing (most pages). First-item-expanded when there's an obvious lead question (e.g. "What is this product?" at the top of a landing page FAQ). Never all-expanded — defeats the scan-first purpose of the accordion.
5. **Use `<details>` + `<summary>` semantics.** Native HTML, keyboard-accessible, no ARIA hand-rolling required. Add a custom `::marker` or rotating chevron via CSS; do NOT replace the semantics with a `<div onclick>` accordion (loses keyboard nav and screen-reader signal).
6. **Order questions by user priority, not internal category.** The top of the list is "what is this / does it do X / how much" — the buying-decision questions. Operational questions ("can I export my data", "do you have an API") sit in the middle. Edge-case questions ("what currencies do you accept") sit at the bottom.

---

## The 5 question categories — pick from these

When the brief doesn't list questions, generate from these five buckets, in order:

1. **Decision** — "What is this? Who is it for? Should I use this or competitor X?" The "should I buy" questions.
2. **Pricing & billing** — "How does the free trial work? Can I cancel? Do you offer annual discounts? What payment methods? Will my price change at renewal?"
3. **Onboarding & operations** — "How long does setup take? Do I need to migrate data? Can my team use it? What integrations are supported?"
4. **Trust & data** — "Is my data private? Where is it stored? Are you SOC2 / GDPR? Do you train models on my data?" (the AI-era version of the trust block).
5. **Support & limits** — "What happens if I exceed the plan limit? What's your support response time? Is there a community / forum? Do you offer onboarding help?"

Pick 1–2 questions from each bucket to build a 5–8 question pricing-FAQ. For a full FAQ page, pick 3–4 from each bucket and surface them under category filter pills.

---

## Layout patterns — three shapes, pick one

### Pattern A — Inline pricing-FAQ block (5–8 questions)

A single-column accordion under the pricing tiers. No search, no categories. The headline `Frequently asked` or `Questions buyers asked first` sets the section. Answers are 1–3 sentences each. Most common pattern. Use this 80% of the time.

### Pattern B — Standalone FAQ page, all-collapsed list (12–20 questions, no categories)

The whole page is the FAQ. Page header (`Help & Questions`), optional one-line search, then the accordion list. Use when the product is simple enough that a flat list reads cleanly and categories would feel ceremonial.

### Pattern C — Standalone FAQ page with category filters (20+ questions OR 4+ distinct concern buckets)

Page header, search input, 3–5 category pills (`All`, `Billing`, `Account`, `Technical`, `Security`), then the filtered accordion. Each `<details>` carries a `data-category="…"` attribute. JS filters in the URL hash or `data-active-cat` on the wrapper. Use only when a flat list would be daunting.

---

## File shape — paste-ready Pattern A (the common case)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>FAQ — {Product}</title>
  <style>
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --fg: #111111;
      --muted: #6b6b6b;
      --border: #e5e5e5;
      --accent: #2f6feb;
      --radius: 10px;
      --font-display: "Inter", -apple-system, system-ui, sans-serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 var(--font-body); }
    .container { max-width: 720px; margin: 0 auto; padding: 80px 24px; }
    .eyebrow { font-size: 13px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }
    h1 { font: 600 36px/1.15 var(--font-display); letter-spacing: -0.02em; margin: 0 0 48px; text-wrap: balance; }
    .faq-list { display: flex; flex-direction: column; gap: 0; border-top: 1px solid var(--border); }
    details {
      border-bottom: 1px solid var(--border);
      padding: 20px 0;
    }
    summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font: 500 17px/1.4 var(--font-display);
      color: var(--fg);
      padding-right: 8px;
    }
    summary::-webkit-details-marker { display: none; }
    summary::after {
      content: "+";
      font: 400 24px/1 var(--font-display);
      color: var(--muted);
      transition: transform 0.2s ease;
    }
    details[open] summary::after { content: "−"; }
    details[open] summary { color: var(--accent); }
    .answer {
      margin-top: 12px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.65;
      max-width: 64ch;
    }
    .answer a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
    .still-have {
      margin-top: 56px;
      padding: 28px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      text-align: center;
    }
    .still-have p { margin: 0 0 12px; font-size: 15px; }
    .still-have a {
      display: inline-block;
      padding: 10px 18px;
      background: var(--accent);
      color: white;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <section class="container" data-cx-id="faq">
    <div class="eyebrow">FAQ</div>
    <h1>Questions buyers asked first.</h1>

    <div class="faq-list" data-cx-id="faq-list">
      <details>
        <summary>Can I try it before I pay?</summary>
        <p class="answer">Yes — 14 days free, no card required. You'll get the full Pro plan; we'll email you a reminder three days before it ends.</p>
      </details>

      <details>
        <summary>Can I cancel anytime?</summary>
        <p class="answer">Yes. Cancel from Settings → Billing in one click. Your plan stays active through the end of the current billing period.</p>
      </details>

      <details>
        <summary>Do you train AI models on my data?</summary>
        <p class="answer">No. Your data is yours; we don't use it for model training. <a href="/security">Read the full security overview →</a></p>
      </details>

      <details>
        <summary>What happens if I exceed the seat limit?</summary>
        <p class="answer">We'll prompt you to add seats at the prorated rate. Nothing breaks; no surprise charges.</p>
      </details>

      <details>
        <summary>Do you offer annual discounts?</summary>
        <p class="answer">Yes — annual billing is 20% off the monthly price. The discount applies automatically when you switch at checkout.</p>
      </details>

      <details>
        <summary>What integrations do you support?</summary>
        <p class="answer">Slack, Linear, GitHub, Notion, Figma, and Zapier today. An open API for everything else. <a href="/integrations">Full integrations list →</a></p>
      </details>
    </div>

    <div class="still-have" data-cx-id="still-have">
      <p>Still have questions? We answer every email within one business day.</p>
      <a href="mailto:hello@example.com">Talk to us</a>
    </div>
  </section>
</body>
</html>
```

Six questions, three sentences max per answer, plus-to-minus chevron transition, "still have questions" CTA at the bottom. That's Pattern A in full.

---

## Concrete examples

### Example 1 — 6-question pricing-page FAQ for a B2B SaaS (project management tool, $20/seat/month)

Real questions, real answers. Use these as a template; adapt nouns to the actual product.

1. **Q: Can I try it before I pay?**
   A: Yes — 14 days free on the Pro plan, no card required. We'll email a reminder three days before the trial ends.

2. **Q: Can I cancel anytime?**
   A: Yes. Cancel in one click from Settings → Billing. The plan stays active through the end of the current billing period.

3. **Q: How does seat pricing work for my team?**
   A: $20 per active seat per month. We auto-bill at the end of the cycle based on the seats actually used, so adding teammates mid-cycle is prorated.

4. **Q: Do you offer annual discounts?**
   A: Yes — annual billing is 20% off the monthly price. Switch from monthly to annual at any time; we'll credit the unused portion.

5. **Q: Will my data be safe? Where is it stored?**
   A: Encrypted at rest (AES-256) and in transit (TLS 1.3). Hosted in US-East (AWS); EU residency available on the Enterprise plan. [Full security overview →](/security)

6. **Q: What's the difference between Pro and Enterprise?**
   A: Pro covers teams up to 50 with self-serve admin. Enterprise adds SSO, SCIM, audit logs, EU data residency, and a dedicated success engineer. [Compare plans →](/pricing#compare)

Six questions, one paragraph each, one outbound link per answer where it earns its place. That's the bar.

### Example 2 — 4-question security-focused FAQ block for an AI product

For an AI tool selling into enterprise, the load-bearing questions live in the "trust & data" bucket. Skip the operational stuff; the buyer is asking about risk.

1. **Q: Do you train your models on my prompts and outputs?**
   A: No. Your inputs and outputs aren't used to train the foundation model or any fine-tune we run. Logged only for abuse review, retained 30 days, then deleted.

2. **Q: Who can see my data inside your company?**
   A: A two-engineer on-call rotation can access logs to debug incidents you report. Every access is audited and visible to your admin in the dashboard.

3. **Q: Are you SOC 2 / GDPR / HIPAA compliant?**
   A: SOC 2 Type II (Type I report available on request; Type II renews March 2026). GDPR-compliant; standard DPA on request. Not HIPAA — we don't take PHI.

4. **Q: Can I delete all my data?**
   A: Yes. One-click data wipe in Settings → Data. Within 24 hours we purge from primary and backups; we'll send a confirmation email when complete.

Four questions, each addresses a real procurement-team objection. Short answers, no hedge words, links only where the long-form earns it.

---

## Anti-patterns

- **"What is {product}?" as the first question on a product's own FAQ.** If the user is on your pricing page, they already know what the product is. Lead with the buying-decision question ("Can I try it free?") not the brand-existence question.
- **"Why are we different from competitors?"** Marketing voice. The user doesn't think in those terms. Re-frame as "How is this different from {specific competitor}?" with an honest comparison, OR cut.
- **Answers that end "Contact sales to learn more."** That's a paywall on information, not an answer. Either tell them the thing or remove the question. Sales-gated answers in a public FAQ destroy trust.
- **"Yes!" "Absolutely!" "Of course!" as the first word.** Tonal. Trust-leaking. Just answer.
- **Five-paragraph answers explaining the product's architecture.** That's a doc, not an FAQ. Cap at 3 sentences and link out.
- **Marketing-voice questions ("What revolutionary features set us apart?").** User-voice or no question. Read the question aloud; if you cringe, rewrite.
- **All-expanded accordion by default.** Defeats the scan-first behavior of an accordion. Use a static list of `<h3> + <p>` if you want everything visible.
- **A search bar on a 6-question FAQ.** Ceremony. Cut.
- **Hidden answers (no expand affordance).** A clickable summary with no visual cue that it expands is an interaction users miss. Always show the `+`/`−` or chevron.
