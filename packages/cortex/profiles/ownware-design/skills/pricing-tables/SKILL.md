---
name: pricing-tables
description: 'Pricing table composition — tier count (3 canonical, 4 only if Enterprise earns it, 1 when confident), middle-tier highlight pattern (lift + accent border + Most Popular badge), comparison row grouping, monthly/annual toggle. Use when building any SaaS pricing page. Pairs with /paywall-design (in-app paywalls) and /psychology-applied (anchoring + decoy effect). Skip if the brief is "single product, one price, one button" — that''s a CTA, not a pricing page.'
trigger: /pricing-tables
---

# Pricing Tables — three tiers, middle highlighted, comparison underneath

## Overview

Pricing tables are the most-A/B-tested surface on the web because they convert money. The patterns that work are well-known and boring; the patterns that don't work are visible on every SaaS landing page because product teams confuse "more options" with "more revenue." Three tiers is canonical. Middle is highlighted. Annual saves something. Comparison row is underneath, not inside the tiles. Most violations of these rules come from the wrong instinct.

Use this for SaaS, B2B tools, and any product with multiple plan tiers. For in-app upgrade prompts, see `/paywall-design`. For the psychology of price anchoring and the decoy effect, see `/psychology-applied`.

---

## Critical Constraints — read these first

1. **3 tiers is canonical. 4 is the maximum and only if "Enterprise" earns its own slot.** Five tiers is decision paralysis; users pick neither. Six tiers is a confession that pricing isn't figured out. Default 3. Add 4th only if Enterprise has a different SHAPE (custom pricing, SSO, SLA, dedicated CSM) — not just bigger numbers.
2. **Middle tier highlighted, always.** "Most Popular" badge + accent border + 2px lift (translateY(-2px)) + slightly taller card. This is the price-anchor: the user reads left tier (cheap, limited), middle tier (recommended), right tier (expensive), and the middle becomes the safe pick. Without highlight, conversion drops measurably.
3. **Comparison rows BELOW the tiles, not INSIDE them.** Tiles show the 3-5 headline features per tier. The full comparison matrix lives below in a separate table. Stuffing 14 features inside each tile makes scanning impossible.
4. **Annual/Monthly toggle ABOVE the tiles, centered.** Segmented control with "Annual (save 20%)" label. Updates all three prices in sync. Default to annual selected — it both increases ACV and signals the "real" price.
5. **One CTA per tier. Same label across tiers (mostly).** "Get started" or "Start free" on all three. Use a different label ONLY for the Enterprise tier ("Contact sales"). Different CTAs per tier confuse the user about what they're buying.
6. **Prices: large numerals, tabular nums, currency before number for USD ($19), period after.** `$19/mo` not `19 USD/month`. Save 30 characters of decision-cost per tile.

---

## Framework

### Tier count rule

| Tier count | When to use | When to avoid |
|------------|-------------|---------------|
| **1 (single tier)** | You're confident in your value and your customer base is narrow enough that segmentation hurts (e.g. Linear historically, Basecamp). The hero IS the pricing. | If users meaningfully differ in usage / team size / feature need, 1 tier under-serves the high end. |
| **3 (canonical)** | Default. Free or Starter / Pro / Business. The middle is your target ARPU. | If your top tier has different SHAPE (SSO, SLA, custom limits), add Enterprise as 4th. |
| **4 (with Enterprise)** | Pro/Business/Premium/Enterprise where the top tier is genuinely "contact sales" + custom terms. | If "Enterprise" is just "Business but more expensive" — collapse to 3. |
| **5+ (avoid)** | Never default. Reserve for truly usage-driven pricing (e.g. AWS) where tiers map to specific compute classes. | B2B SaaS. Period. Cut to 3-4. |

### Middle tier highlight pattern

The middle tier gets ALL of these signals together (any one alone is too subtle):

1. **"Most Popular" or "Recommended" badge** — small chip floating at top of card. `--cx-accent` background, `--cx-accent-fg` text, 12px caps, 6px padding, `-12px` margin-top so it sits above the card edge.
2. **Accent border** — `border: 2px solid var(--cx-accent)` (vs `1px solid var(--cx-border)` on other tiles).
3. **Lift** — `transform: translateY(-2px)`. Subtle, but the card visually elevates.
4. **Slightly larger** — `padding: 32px 28px` vs `28px 24px` on other tiles. The middle reads as "bigger" without being grotesque.
5. **Optional: filled CTA** on middle, ghost CTA on the others. If the others are ghost, middle is filled. If the others are already filled (rare), middle gets accent-bg variant.

### Comparison row pattern (below the tiles)

```
| Feature                | Starter | Pro      | Business |
| ---------------------- | ------- | -------- | -------- |
| **Core**                                              |
| Workspaces             | 1       | 5        | Unlimited|
| Team members           | 3       | 15       | Unlimited|
| **Collaboration**                                     |
| Shared workspaces      | —       | ✓        | ✓        |
| Guests                 | —       | 10       | Unlimited|
| Granular permissions   | —       | —        | ✓        |
| **Support**                                           |
| Community              | ✓       | ✓        | ✓        |
| Email                  | —       | ✓        | ✓        |
| Priority + SLA         | —       | —        | ✓        |
```

Rules:
- **Group features under bold section headers** (Core / Collaboration / Support). 3-5 features per group.
- **Use ✓ for "included", em-dash `—` for "not included".** Never `✗` (red X) — feels punitive.
- **For limited features, write the actual number** ("5 workspaces", "10 guests") not "✓". Numbers communicate scale better than ticks.
- **Header row sticky on scroll** so the user can scroll the matrix and still see which column is which tier.
- **First column left-aligned, value columns center-aligned.**
- **Row hover state**: subtle `background: --cx-sunken` so the user can track which row they're scanning.

### Annual / Monthly toggle

Position: centered ABOVE the pricing tiles, with ~32-48px clearance.

```html
<div class="billing-toggle">
  <button class="toggle-btn is-active" data-period="annual">Annual <span class="toggle-save">Save 20%</span></button>
  <button class="toggle-btn" data-period="monthly">Monthly</button>
</div>
```

```css
.billing-toggle {
  display: inline-flex;
  background: var(--cx-sunken);
  border-radius: 999px;
  padding: 4px;
  margin: 0 auto 48px;
}
.toggle-btn {
  padding: 8px 20px;
  border: none;
  background: transparent;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 500;
  color: var(--cx-muted);
  cursor: pointer;
  transition: all 120ms ease-out;
}
.toggle-btn.is-active {
  background: var(--cx-surface);
  color: var(--cx-fg-strong);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}
.toggle-save {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--cx-good);
}
```

Default state: Annual selected. When user clicks Monthly, JS updates all `.tier-price` values and the period label.

---

## Concrete examples

### Example 1 — Canonical 3-tier SaaS pricing ($19 / $49 / $99)

```html
<section class="pricing" data-cx-id="pricing">
  <header class="pricing-head">
    <h2>Simple, transparent pricing</h2>
    <p>Start free. Scale when you're ready.</p>
    <div class="billing-toggle" role="tablist">
      <button class="toggle-btn is-active" data-period="annual">Annual <span class="toggle-save">Save 20%</span></button>
      <button class="toggle-btn" data-period="monthly">Monthly</button>
    </div>
  </header>

  <div class="tiers">

    <article class="tier" data-tier="starter">
      <h3 class="tier-name">Starter</h3>
      <p class="tier-tagline">For solo founders getting started.</p>
      <p class="tier-price">
        <span class="price-currency">$</span>
        <span class="price-amount">19</span>
        <span class="price-period">/mo</span>
      </p>
      <p class="tier-billed">Billed annually. $24/mo billed monthly.</p>
      <a href="#signup-starter" class="btn-ghost">Get started</a>
      <ul class="tier-features">
        <li>1 workspace</li>
        <li>3 team members</li>
        <li>Community support</li>
        <li>10GB storage</li>
      </ul>
    </article>

    <article class="tier is-featured" data-tier="pro">
      <span class="tier-badge">Most popular</span>
      <h3 class="tier-name">Pro</h3>
      <p class="tier-tagline">For growing teams shipping every day.</p>
      <p class="tier-price">
        <span class="price-currency">$</span>
        <span class="price-amount">49</span>
        <span class="price-period">/mo</span>
      </p>
      <p class="tier-billed">Billed annually. $61/mo billed monthly.</p>
      <a href="#signup-pro" class="btn-primary">Get started</a>
      <ul class="tier-features">
        <li>5 workspaces</li>
        <li>15 team members</li>
        <li>Email support</li>
        <li>100GB storage</li>
        <li>Granular permissions</li>
      </ul>
    </article>

    <article class="tier" data-tier="business">
      <h3 class="tier-name">Business</h3>
      <p class="tier-tagline">For organizations with serious scale.</p>
      <p class="tier-price">
        <span class="price-currency">$</span>
        <span class="price-amount">99</span>
        <span class="price-period">/mo</span>
      </p>
      <p class="tier-billed">Billed annually. $124/mo billed monthly.</p>
      <a href="#signup-business" class="btn-ghost">Get started</a>
      <ul class="tier-features">
        <li>Unlimited workspaces</li>
        <li>Unlimited team members</li>
        <li>Priority support + SLA</li>
        <li>1TB storage</li>
        <li>SSO + SAML</li>
        <li>Audit log</li>
      </ul>
    </article>

  </div>

  <!-- Comparison row below -->
  <details class="compare-row" open>
    <summary>Compare all features</summary>
    <table class="compare-table">
      <thead>
        <tr>
          <th scope="col">Feature</th>
          <th scope="col">Starter</th>
          <th scope="col">Pro</th>
          <th scope="col">Business</th>
        </tr>
      </thead>
      <tbody>
        <tr class="group-row"><th colspan="4">Core</th></tr>
        <tr><th scope="row">Workspaces</th><td>1</td><td>5</td><td>Unlimited</td></tr>
        <tr><th scope="row">Team members</th><td>3</td><td>15</td><td>Unlimited</td></tr>
        <tr><th scope="row">Storage</th><td>10GB</td><td>100GB</td><td>1TB</td></tr>

        <tr class="group-row"><th colspan="4">Collaboration</th></tr>
        <tr><th scope="row">Shared workspaces</th><td>—</td><td>✓</td><td>✓</td></tr>
        <tr><th scope="row">Guests</th><td>—</td><td>10</td><td>Unlimited</td></tr>
        <tr><th scope="row">Granular permissions</th><td>—</td><td>✓</td><td>✓</td></tr>

        <tr class="group-row"><th colspan="4">Security</th></tr>
        <tr><th scope="row">SSO + SAML</th><td>—</td><td>—</td><td>✓</td></tr>
        <tr><th scope="row">Audit log</th><td>—</td><td>—</td><td>✓</td></tr>

        <tr class="group-row"><th colspan="4">Support</th></tr>
        <tr><th scope="row">Community</th><td>✓</td><td>✓</td><td>✓</td></tr>
        <tr><th scope="row">Email</th><td>—</td><td>✓</td><td>✓</td></tr>
        <tr><th scope="row">Priority + SLA</th><td>—</td><td>—</td><td>✓</td></tr>
      </tbody>
    </table>
  </details>
</section>

<style>
.pricing { max-width: 1200px; margin-inline: auto; padding: 96px 32px; }
.pricing-head { text-align: center; margin-bottom: 56px; }
.pricing-head h2 {
  font-size: clamp(36px, 5vw, 56px);
  line-height: 1.1;
  letter-spacing: -0.02em;
  text-wrap: balance;
  margin: 0 0 12px;
  color: var(--cx-fg-strong);
}
.pricing-head p {
  font-size: 18px;
  color: var(--cx-muted);
  margin: 0 0 32px;
}

.tiers {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  align-items: stretch;
}

.tier {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--cx-surface);
  border: 1px solid var(--cx-border);
  border-radius: 16px;
  padding: 28px 24px;
}
.tier.is-featured {
  border: 2px solid var(--cx-accent);
  padding: 32px 28px;
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(110, 89, 224, 0.12);
}
.tier-badge {
  position: absolute;
  top: -14px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--cx-accent);
  color: var(--cx-accent-fg);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 6px 14px;
  border-radius: 999px;
}
.tier-name {
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--cx-muted);
  margin: 0 0 4px;
}
.tier-tagline {
  font-size: 14px;
  color: var(--cx-muted);
  margin: 0 0 24px;
  min-height: 2lh;
}
.tier-price {
  display: flex;
  align-items: baseline;
  gap: 2px;
  margin: 0 0 4px;
  font-variant-numeric: tabular-nums;
}
.price-currency { font-size: 24px; font-weight: 500; color: var(--cx-muted); }
.price-amount { font-size: 56px; font-weight: 700; line-height: 1; color: var(--cx-fg-strong); letter-spacing: -0.02em; }
.price-period { font-size: 16px; color: var(--cx-muted); margin-left: 4px; }
.tier-billed {
  font-size: 13px;
  color: var(--cx-muted);
  margin: 0 0 24px;
}
.btn-primary, .btn-ghost {
  display: block;
  text-align: center;
  padding: 12px 20px;
  font-size: 15px;
  font-weight: 500;
  border-radius: 8px;
  text-decoration: none;
  transition: all 120ms ease-out;
  margin-bottom: 24px;
}
.btn-primary {
  background: var(--cx-accent);
  color: var(--cx-accent-fg);
  border: 1px solid var(--cx-accent);
}
.btn-primary:hover { background: var(--cx-accent-hover, var(--cx-accent)); }
.btn-ghost {
  background: transparent;
  color: var(--cx-fg);
  border: 1px solid var(--cx-border);
}
.btn-ghost:hover { background: var(--cx-sunken); }

.tier-features {
  list-style: none;
  padding: 0;
  margin: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tier-features li {
  font-size: 14px;
  color: var(--cx-fg);
  padding-left: 24px;
  position: relative;
}
.tier-features li::before {
  content: '✓';
  position: absolute;
  left: 0;
  color: var(--cx-accent);
  font-weight: 600;
}

.compare-row { margin-top: 80px; }
.compare-row summary {
  text-align: center;
  font-size: 16px;
  font-weight: 600;
  color: var(--cx-accent);
  cursor: pointer;
  padding: 12px;
  margin-bottom: 24px;
}
.compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.compare-table thead th {
  position: sticky; top: 0;
  background: var(--cx-bg);
  text-align: center;
  font-weight: 600;
  color: var(--cx-fg-strong);
  padding: 12px 16px;
  border-bottom: 2px solid var(--cx-border);
}
.compare-table thead th:first-child { text-align: left; }
.compare-table tbody th[scope="row"] {
  text-align: left;
  font-weight: 400;
  color: var(--cx-fg);
  padding: 12px 16px;
}
.compare-table td {
  text-align: center;
  padding: 12px 16px;
  color: var(--cx-fg);
  font-variant-numeric: tabular-nums;
}
.compare-table tbody tr { border-bottom: 1px solid var(--cx-border); }
.compare-table tbody tr:hover { background: var(--cx-sunken); }
.group-row th {
  background: var(--cx-sunken);
  text-align: left;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--cx-muted);
  padding: 12px 16px;
}

@media (max-width: 880px) {
  .tiers { grid-template-columns: 1fr; }
  .tier.is-featured { transform: none; }
}
</style>
```

What this gets right:
- 3 tiers, middle highlighted with all 5 signals (badge, accent border, lift, larger padding, filled CTA vs ghosts on the others).
- Annual selected by default. Monthly price shown in fine print for reference.
- Same CTA label ("Get started") across all three — the choice is the tier, not the action.
- Comparison row below, collapsible (`<details>`), grouped by section.
- Tabular nums on every price and every numeric cell.
- Mobile: tiers stack, featured loses the lift (it would create a layout gap on stacked layouts).

### Example 2 — When to use 4 tiers (Enterprise earns its slot)

If the brief is "B2B SaaS, $19 / $49 / $99, plus we have a real Enterprise plan with SSO + SLA + dedicated CSM at $1500/mo+ custom":

Add a 4th tier:

```html
<article class="tier" data-tier="enterprise">
  <h3 class="tier-name">Enterprise</h3>
  <p class="tier-tagline">For organizations with compliance and scale needs.</p>
  <p class="tier-price">
    <span class="price-amount">Custom</span>
  </p>
  <p class="tier-billed">Annual contract. Volume + commitment discounts.</p>
  <a href="#contact-sales" class="btn-ghost">Contact sales</a>
  <ul class="tier-features">
    <li>Everything in Business, plus:</li>
    <li>SSO + SAML + SCIM</li>
    <li>99.99% SLA</li>
    <li>Dedicated CSM</li>
    <li>Custom data residency</li>
    <li>Procurement support</li>
  </ul>
</article>
```

Rules for the 4th tier:
- Different CTA: "Contact sales" not "Get started".
- "Custom" or "Let's talk" instead of a number. Don't list a starting price — it locks you out of $5K and $50K deals.
- "Everything in Business, plus:" pattern at the top of the feature list — saves the user from re-reading what they already know.
- 4-tier grid: `grid-template-columns: repeat(4, 1fr); gap: 12px;`. Slightly tighter gap because tiles are narrower.

---

## Anti-patterns

- **5+ tiers in B2B SaaS pricing.** Decision paralysis. Cut to 3 or 4.
- **"Most Popular" badge with NO other highlight signals.** Too subtle to land. Pair the badge with border + lift + padding.
- **Two highlighted tiers ("Most Popular" + "Best Value").** Diffuses the anchor. ONE highlighted tier.
- **All 12 features listed inside each tile.** Tiles become unscannable. 4-5 headline features per tile; full matrix in the comparison row below.
- **Monthly default with a tiny "or annual" link.** Costs ARR. Default annual, monthly visible but secondary.
- **"Contact sales" on multiple tiers.** Now the user doesn't know which one to ask about. Reserve "Contact sales" for Enterprise only.
- **Red ✗ for "not included".** Reads punitive. Use em-dash `—`.
- **Different CTA labels per tier ("Start free" / "Upgrade now" / "Get a quote").** The user is choosing tiers, not actions. Same label across (except Enterprise's "Contact sales").
- **Hiding the monthly price for annual plans.** Users want to see what they're saving against. Show `$19/mo billed annually` + `$24/mo billed monthly` so the discount is visible.
- **Numeric values stuffed inside the feature `<li>` without scannable structure ("Up to 5 workspaces and 15 members").** Break it into separate features: "5 workspaces" + "15 team members". The user scans bullet count, not bullet length.
- **Comparison table without sticky header.** User scrolls down the matrix, forgets which column is which tier. Sticky `<thead>`.
- **No mobile responsive plan.** Three tiles side-by-side at 320px wide is unusable. Stack on `<880px`. Drop the lift on stacked layouts (it creates a visible gap).
