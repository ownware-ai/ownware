---
name: paywall-design
description: Paywall, upgrade screen, or in-app upsell modal HTML artifact — pricing tiers, highlighted recommended plan, FAQ block below, legally-required back button. Use when the brief is "design the paywall", "make an upgrade modal", "build the pricing-screen the user hits when they hit the free limit". Skip for full marketing pricing pages (that's artifact + web-guidelines + this skill combined) and for one-off ad creatives (use ad-copy).
trigger: /paywall-design
---

# Paywall Design — the moment of conversion, designed honestly

## Overview

A paywall is the highest-stakes screen in the product: the user is interrupted, asked for money, and one wrong move flips them from "buying" to "churning". This skill ships the paywall as a single self-contained HTML file with a tier layout, a highlighted recommended plan, a must-have FAQ block, and a legally-required back button. The design has to convert without burning the bridge.

This skill is a SURFACE skill — the paywall HTML artifact. For the persuasive copy and pricing-anchor moves (anchoring, loss aversion, decoy pricing), lean on `/psychology-applied`. For the headline variants and tier-name copy, lean on `/copy-refiner`. For the ad-style hook copy if the paywall is reached via an upsell, lean on `/ad-copy`. **This skill owns the LAYOUT, not the persuasion.**

---

## Critical Constraints — read these first, every time

1. **One screen, one decision.** The paywall asks one question: "Which plan?" — not "Want to subscribe? Or trial? Or pay-as-you-go? Or contact sales?" Pick the canonical flow (usually: 3 tiers with one highlighted) and commit. Branch later.
2. **One tier highlighted, not zero, not two.** A 3-tier card with the middle tier elevated (border, badge "Most popular", subtle background tint) is the canonical conversion pattern. Zero highlight = the user picks the cheapest. Two highlights = paralysis.
3. **Pricing displayed as `$X / month`, with annual discount visible.** Show monthly equivalent of annual as the primary number (`$16/mo billed annually`); a monthly-only toggle reveals the un-discounted price. Never hide the annual savings; never hide the monthly equivalent.
4. **Legally-required back button — visible, never hidden.** In the EU and UK, dark patterns that obstruct cancellation or back-out (no close button on a modal, browser-history blocking, etc.) violate the EU Digital Services Act and UK CMA guidance. The back-to-app affordance is REQUIRED. Cap-X close button top-right of any modal, "Continue with free plan" link below the CTAs on a full-screen paywall.
5. **FAQ block below the tiers — 3 to 5 objection-answers.** The user is at the moment of paying; they have objections. Surfacing them in a small FAQ below the pricing converts 8–14% better than not surfacing them. Standard set: "Can I cancel anytime?", "What if I exceed my plan?", "Do you offer refunds?", "Is my payment secure?". For the structure, use `/faq-design` patterns (3-sentence answers, `<details>` accordion).
6. **One primary CTA per tier, not "Choose plan" + "Talk to sales" doubled up.** Each tier shows the CTA matching its position: free → "Continue with free", paid tiers → "Start 14-day trial" or "Subscribe — $20/mo", enterprise → "Contact sales". One verb per button.
7. **Trust signals near the CTA, not at the top.** Card icons (Visa/MC/Amex/Apple Pay), a "Cancel anytime" microcopy, an SSL/PCI badge. These belong directly under the primary CTA where the buying decision happens. Putting them at the top of the page wastes their attention.

---

## Layout patterns — three shapes, pick by context

### Pattern A — 3-tier card grid, middle highlighted (the canonical SaaS paywall)

Used 70% of the time. Three cards side-by-side: Starter / Pro (highlighted) / Enterprise. Each card has: name, price, one-line description, feature checklist (5–8 items), CTA button. Pro card carries a "Most popular" badge, a colored border (`2px solid var(--accent)`), and sits visually elevated (slight scale up, or stronger shadow). Stack vertically on mobile.

### Pattern B — Single-tier hero (the "one product, one price" paywall)

Used when there's genuinely one product, one price. Common for indie tools, consumer apps. The whole screen is the value proposition + ONE pricing card centered. Larger headline, more product photography or feature illustration. CTA is the biggest button on the page.

### Pattern C — Comparison table (the enterprise upgrade screen)

Used when feature differentiation matters more than price differentiation — common at the enterprise level. Full feature table with rows for every feature and check/dash columns per tier. Header row is sticky on scroll. Below the table, the same CTA-per-tier row.

---

## The anti-pattern: "compare against free" tier-shaming

A common mistake is presenting the free tier as visibly diminished — gray card, missing checkmarks rendered as red Xs, prices crossed out. This backfires in two ways:

1. **It signals you're embarrassed of the free product.** Users on free convert later, when their use case matures. If you make them feel small today, they churn instead of upgrade later.
2. **It triggers reactance.** Pressure to upgrade reads as desperation; users actively resist. The honest move is to make the free tier look fully featured for its scope, and the paid tiers look like a clear upgrade for users who outgrow the free one.

The right tier presentation: every tier looks like a real product the company is proud of. The differences are additive ("Pro adds: SSO, audit logs, …"), not subtractive ("Free is missing: SSO, audit logs, …"). Same checkmarks for every tier on shared features; only NEW features list per tier.

---

## File shape — paste-ready 3-tier SaaS paywall

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Plans — {Product}</title>
  <style>
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --surface-elevated: #ffffff;
      --fg: #0a0a0a;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #2f6feb;
      --accent-soft: rgba(47,111,235,0.08);
      --accent-fg: #ffffff;
      --good: #16a34a;
      --radius: 12px;
      --font-display: "Inter", -apple-system, system-ui, sans-serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--font-body); }
    .page { max-width: 1100px; margin: 0 auto; padding: 56px 24px 80px; }
    .back-link { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 14px; text-decoration: none; margin-bottom: 32px; }
    .header { text-align: center; margin-bottom: 40px; }
    .header h1 { font: 600 36px/1.15 var(--font-display); letter-spacing: -0.02em; margin: 0 0 12px; text-wrap: balance; }
    .header p { color: var(--muted); font-size: 17px; margin: 0; }
    .billing-toggle { display: inline-flex; gap: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 4px; margin-top: 24px; }
    .billing-toggle button { padding: 8px 18px; border: none; background: transparent; font: 500 14px var(--font-body); border-radius: 999px; cursor: pointer; color: var(--muted); }
    .billing-toggle button.active { background: var(--fg); color: white; }
    .billing-toggle .save { color: var(--good); font-size: 12px; margin-left: 6px; }

    .tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 40px; }
    .tier {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px 28px;
      display: flex; flex-direction: column;
      position: relative;
    }
    .tier.featured {
      border: 2px solid var(--accent);
      transform: translateY(-8px);
      box-shadow: 0 16px 48px rgba(47,111,235,0.12);
    }
    .badge {
      position: absolute; top: -12px; left: 50%; transform: translateX(-50%);
      background: var(--accent); color: var(--accent-fg);
      font-size: 12px; font-weight: 600; padding: 4px 10px;
      border-radius: 999px;
      letter-spacing: 0.02em;
    }
    .tier h2 { font: 600 20px var(--font-display); margin: 0 0 8px; }
    .tier .desc { color: var(--muted); font-size: 14px; min-height: 40px; margin: 0 0 20px; }
    .tier .price { font: 700 44px/1 var(--font-display); letter-spacing: -0.02em; margin-bottom: 4px; }
    .tier .price-unit { color: var(--muted); font-size: 14px; }
    .tier .billed { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .tier ul { list-style: none; padding: 0; margin: 0 0 28px; flex: 1; }
    .tier li {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 6px 0; font-size: 14px;
    }
    .tier li::before {
      content: "✓"; color: var(--good); font-weight: 700; flex-shrink: 0;
    }
    .tier .cta {
      width: 100%; height: 44px; border: 1px solid var(--border);
      background: var(--surface); color: var(--fg);
      border-radius: 8px; font: 600 14px var(--font-body); cursor: pointer;
    }
    .tier.featured .cta { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .tier .cta:hover { background: #f9f9f9; }
    .tier.featured .cta:hover { background: #1f5fd6; }
    .trust { text-align: center; color: var(--muted); font-size: 13px; margin-top: 24px; }
    .trust .icons { font-size: 18px; letter-spacing: 8px; margin-bottom: 6px; }

    .faq { max-width: 720px; margin: 64px auto 0; }
    .faq h2 { font: 600 22px/1.2 var(--font-display); text-align: center; margin: 0 0 24px; }
    .faq details { border-bottom: 1px solid var(--border); padding: 16px 0; }
    .faq summary { cursor: pointer; list-style: none; font-weight: 500; font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
    .faq summary::-webkit-details-marker { display: none; }
    .faq summary::after { content: "+"; color: var(--muted); font-size: 20px; }
    .faq details[open] summary::after { content: "−"; }
    .faq .answer { color: var(--muted); font-size: 14px; line-height: 1.6; margin-top: 10px; }

    .continue-free { text-align: center; margin-top: 40px; }
    .continue-free a { color: var(--muted); font-size: 14px; text-decoration: underline; text-underline-offset: 2px; }

    @media (max-width: 880px) {
      .tiers { grid-template-columns: 1fr; }
      .tier.featured { transform: none; }
    }
  </style>
</head>
<body>
  <main class="page" data-cx-id="page">
    <a href="/" class="back-link" data-cx-id="back">← Back to Acme</a>

    <header class="header" data-cx-id="header">
      <h1>Pick a plan that fits your team.</h1>
      <p>Start with a 14-day trial. No credit card required.</p>
      <div class="billing-toggle" role="tablist">
        <button class="active">Annual <span class="save">save 20%</span></button>
        <button>Monthly</button>
      </div>
    </header>

    <section class="tiers" data-cx-id="tiers">
      <div class="tier" data-tier="starter">
        <h2>Starter</h2>
        <p class="desc">For individuals and side-projects.</p>
        <div class="price">$0<span class="price-unit"> /mo</span></div>
        <div class="billed">Free forever</div>
        <ul>
          <li>Up to 3 projects</li>
          <li>500 events / month</li>
          <li>Community support</li>
          <li>Core integrations</li>
        </ul>
        <button class="cta">Continue with Starter</button>
      </div>

      <div class="tier featured" data-tier="pro">
        <div class="badge">MOST POPULAR</div>
        <h2>Pro</h2>
        <p class="desc">For growing teams that need more horsepower.</p>
        <div class="price">$16<span class="price-unit"> /mo</span></div>
        <div class="billed">$192 billed annually · $20/mo monthly</div>
        <ul>
          <li>Unlimited projects</li>
          <li>50,000 events / month</li>
          <li>Email + Slack support, &lt; 1 business day</li>
          <li>All integrations + open API</li>
          <li>Role-based access for the team</li>
          <li>Custom domains</li>
        </ul>
        <button class="cta">Start 14-day trial</button>
      </div>

      <div class="tier" data-tier="enterprise">
        <h2>Enterprise</h2>
        <p class="desc">For organizations with compliance needs.</p>
        <div class="price">Talk to us</div>
        <div class="billed">Annual contract</div>
        <ul>
          <li>Everything in Pro</li>
          <li>SSO (Okta, Azure AD, Google)</li>
          <li>SCIM provisioning</li>
          <li>Audit logs + SOC 2 report</li>
          <li>EU data residency</li>
          <li>Dedicated success engineer</li>
        </ul>
        <button class="cta">Contact sales</button>
      </div>
    </section>

    <div class="trust" data-cx-id="trust">
      <div class="icons">Visa · MC · Amex · Apple Pay</div>
      Cancel anytime · Payments secured by Stripe (PCI DSS Level 1)
    </div>

    <section class="faq" data-cx-id="faq">
      <h2>Common questions</h2>
      <details>
        <summary>Can I cancel anytime?</summary>
        <p class="answer">Yes. Cancel from Settings → Billing in one click. Your plan stays active through the end of the current billing period.</p>
      </details>
      <details>
        <summary>What happens if I exceed my event limit?</summary>
        <p class="answer">We'll email you at 80% and 100%. Nothing breaks; we keep ingesting and bill the overage at $0.20 per 1,000 extra events at the end of the cycle.</p>
      </details>
      <details>
        <summary>Do you offer refunds?</summary>
        <p class="answer">Yes — 30-day money-back guarantee, no questions asked. Email us and we'll process the refund within 2 business days.</p>
      </details>
      <details>
        <summary>How is my payment information stored?</summary>
        <p class="answer">We never store your card. Payments are handled by Stripe, PCI DSS Level 1 certified. We see only the last 4 digits and the brand for your records.</p>
      </details>
      <details>
        <summary>Can I switch plans later?</summary>
        <p class="answer">Yes — upgrade or downgrade from Settings → Billing at any time. Upgrades take effect immediately (prorated); downgrades take effect at the next renewal.</p>
      </details>
    </section>

    <div class="continue-free" data-cx-id="continue-free">
      <a href="/app">Not ready? Continue with the Starter plan →</a>
    </div>
  </main>
</body>
</html>
```

3 tiers, middle elevated, "MOST POPULAR" badge, annual savings visible, FAQ below with 5 questions, "Continue with Starter" escape hatch, back-link top-left. That's the full canonical shape.

---

## Concrete examples

### Example 1 — 3-tier SaaS paywall (above)

Pasted above as the file-shape. Middle Pro tier highlighted with `border: 2px solid var(--accent)` plus `transform: translateY(-8px)` and a softer shadow; "MOST POPULAR" badge in accent color. Pricing shows $16/mo as the lead number with a sub-line clarifying annual vs monthly. Five-question FAQ uses the same `/faq-design` `<details>` pattern.

### Example 2 — In-app upgrade modal when a user hits a free-tier limit

Same tier layout, simplified — 2 tiers (current free + paid upgrade), modal dialog format rather than full page. Triggered after the user hits e.g. "5/5 projects used".

- **Modal:** centered card, max-width 520px, scrim background `rgba(0,0,0,0.5)`.
- **Header:** "You've hit your project limit on the Starter plan." — names the limit explicitly, not "Upgrade your account!"
- **Two tiers stacked vertically:** Starter (greyed-out, indicating current) and Pro (highlighted, with the unlock copy: "Unlimited projects starting at $16/mo").
- **Primary CTA:** "Upgrade to Pro" full-width.
- **Secondary affordance:** Cap-X close in the top-right (legally required), plus "Delete a project instead" link below the CTA — the honest acknowledgement that the user has an alternative.
- **Trust line under CTA:** "14-day trial · Cancel anytime · 30-day refund".

The "delete a project instead" link is the trust move. Users who feel cornered churn; users who feel respected upgrade.

### Example 3 — single-tier consumer paywall (indie app, one price)

For a consumer app with one price ("$8/month or $60/year"), Pattern B applies:

- **Hero:** 60px headline naming the value ("Everything in your inbox, organized."), 18px subhead, illustration or product screenshot below.
- **Single tier card:** centered, max-width 380px. Two CTAs stacked: "$60/year — save 38%" (primary, accent) and "$8/month" (secondary, outlined). Both clearly named, no toggle.
- **Trust line:** card icons + "Cancel anytime · 30-day refund".
- **FAQ:** 3 questions below — "Can I cancel?", "Refund policy?", "What's included?".
- **Continue free:** "Keep using the free plan" link, muted, bottom of page.

Three regions: hero / pricing card / FAQ. Linear scan. No tier comparison because there isn't one.

---

## Anti-patterns

- **Burn-the-bridge dark pattern.** Hiding the close button on a paywall modal. Disabling the browser back button. Forcing the user through three "Are you sure you want to leave?" confirmations. In the EU and UK, this violates the DSA and UK CMA dark-pattern guidance — and it never converts anyone genuinely. Always show the back affordance.
- **Comparing tiers against the free plan by listing what free DOESN'T have.** Red Xs next to features on the free tier reads as tier-shaming and triggers reactance. Show every tier additively. Free has features; paid adds more.
- **No "Most popular" highlight.** A 3-tier grid with no visual hierarchy = users default to the cheapest. The middle-tier highlight is the single biggest conversion lever on a paywall.
- **Annual price as the primary number ($192) without the monthly equivalent ($16/mo) visible.** Sticker shock. Always lead with monthly-equivalent, secondary with annual-billed-total.
- **CTA copy `Submit` or `Get started` on the paid tier.** Names neither the action nor the cost. Use `Start 14-day trial` or `Subscribe — $16/mo` — the user reads exactly what they're committing to.
- **No FAQ block below the tiers.** The user has objections at the moment of paying; surfacing them lifts conversion 8–14% on average. Cap at 5 questions, real objection-answers, not marketing.
- **"Contact sales" as the CTA on every paid tier.** Self-serve buyers leave. Reserve "Contact sales" for Enterprise; let Pro be self-serve with a card.
- **Pricing displayed as `$19.99`.** The `.99` is consumer-retail trickery; B2B buyers read it as cheap. Round prices (`$20`, `$16`, `$200`) signal confidence.
- **Refund policy hidden in the footer.** Surface "30-day refund" near the CTA. Hiding it sends the signal you'd prefer not to give one.
- **Trust badges (SSL, Stripe, PCI) crammed into a tiny gray strip at the top.** They earn their attention near the moment of decision — under the CTA — not at the page header.
