---
name: psychology-applied
description: 'Behavioral-science principles applied to copy, layout, pricing, and CTAs — with concrete framings, before/after rewrites, and the ethical line between persuasion and manipulation. Use when tightening hooks, framing pricing, or arguing about CTA copy. Skip for pure aesthetic critique (use /critique) or full pre-ship gate (use /design-review-framework).'
trigger: /psychology-applied
---

# Psychology Applied — persuasion in service of the user

## Overview

Most "AI design" advice is decorative ("use a gradient"). The principles below are load-bearing — they're the actual reason a page converts or doesn't, why one pricing layout reads as fair and another reads as a trap, why one CTA feels honest and another feels manipulative. Use this skill when copy, layout, pricing, or CTA wording is the lever. For aesthetic-only critique, use `critique`. For a full ship-gate review, use `design-review-framework`.

The ethical line is firm: persuasion helps a user act on what they already want; manipulation tricks them into wanting something they don't. Every principle below has a "manipulation line" callout — cross it and you're working against the user, not for them.

---

## Critical Constraints — read every time

1. **Persuasion is for true claims.** Never engineer urgency that isn't real. Never invent scarcity. Never invent social proof. If the principle requires a fact you don't have, get the fact or skip the principle.
2. **Every principle has a manipulation line.** Cross it once and trust is gone. The line is explicit per-principle below.
3. **Test the rewrite against "would I say this to a friend?"** If "act now or miss out forever!" wouldn't survive that test, neither should the headline.
4. **No principle works on its own; the page works as a system.** Stacking 8 persuasion patterns on one page reads as a scam. Use 2–3 deliberate moves.
5. **Pricing is the highest-stakes surface.** More than any other, pricing copy and layout are where ethical lines matter. Re-read the pricing section before touching pricing.

---

## The 8 principles, applied

### 1. Loss aversion (Kahneman & Tversky)

Humans weight losses ~2× as heavily as equivalent gains. Frame the CTA around what the user *loses* by not acting, not just what they gain.

- **Headline framing.** "Stop losing 4 hours a week to vendor onboarding" beats "Save 4 hours a week on vendor onboarding" for the same product.
- **Empty-state copy.** "Your team hasn't connected Slack yet — your alerts are going to nobody" beats "Connect Slack to get alerts."
- **Pricing.** "Lose your custom theme" sounds worse than "Standard themes only" on a downgrade screen.

**Concrete rewrite:**
- Before: "Get 30% off Pro for the first year."
- After: "After Friday, Pro goes back to full price."

**Manipulation line:** the loss must be a real loss the user actually incurs. Inventing "you'll miss out on our exclusive…" when the exclusivity isn't real crosses the line. If the offer renews next month, don't pretend it's once-in-a-lifetime.

### 2. Social proof (Cialdini)

Humans use other humans' behavior as evidence of what's correct, especially under uncertainty. Social proof on a landing page is the single highest-leverage move — and the single most often faked.

- **Testimonials must have all four.** Name + photo + role + measurable outcome. Missing any one and the testimonial reads fake. "Sarah K., happy customer" is worse than no testimonial at all.
- **Logos must be real customers.** "Trusted by Acme, Globex, Initech" with logos the user has heard of beats a vague "1000+ companies."
- **Usage numbers must be specific.** "Used by 12,847 engineers at companies like Stripe, Figma, and Linear" beats "Trusted by thousands."

**Concrete rewrite:**
- Before: "Loved by teams everywhere."
- After: "Maya Chen, Head of Procurement at Notion — '4 hours of vendor review per week back, every week.'" (with her photo, her actual quote, the actual number).

**Manipulation line:** every name, role, photo, outcome, and logo must correspond to a real person/company who actually said/did that thing. Stock photos, AI-generated faces, and "representative" testimonials are over the line.

### 3. Anchoring (Tversky & Kahneman)

The first number the user sees becomes the reference point for every subsequent number — even if the anchor is irrelevant.

- **Pricing tiers always show highest first.** $499 / $99 / $29 reads differently from $29 / $99 / $499. After the eye anchors on $499, $99 feels like a deal.
- **Discount framing leads with original.** "$200 ~~$500~~" anchors at $500; "$200 (save $300)" reads weaker.
- **Comparison tables put the recommended tier in the middle, biggest tier on the right.** Eye flow: scan left → see recommended in the middle → see the "enterprise" wall on the right. Middle tier feels reasonable by anchoring on both sides.

**Concrete rewrite:**
- Pricing card order: Enterprise (custom — anchor) | Pro ($99/mo — recommended) | Starter ($29/mo) — middle feels right.
- Hero stat order: "From $2,400/mo of manual vendor review work (anchor) to 12 minutes" — the big number first.

**Manipulation line:** the anchor must be a real reference, not invented. "Originally $999, now $99!" when the product never sold at $999 is fraud, not anchoring.

### 4. Reciprocity (Cialdini)

Humans feel obligation to return a gift. Give the user real value before asking for anything.

- **Lead with the useful thing.** A landing page that ships a free calculator, template, or checklist before the signup form converts higher than one that gates everything.
- **First-touch should teach, not sell.** A docs page that solves the user's immediate problem ("how do I export to CSV") before asking them to upgrade builds reciprocity.
- **Don't break it with "now give us your email."** Reciprocity vanishes if the gift comes with a price tag.

**Concrete rewrite:**
- Before: "Sign up to download our pricing guide."
- After: "Pricing guide (PDF, no signup): [link]. If you find it useful, the product that built it is here."

**Manipulation line:** the gift must be valuable on its own. A "free" thing the user has to give an email for, that turns out to be 4 pages of ad copy, is a bait-and-switch.

### 5. Commitment / consistency (Cialdini)

Humans want their actions to align with their past statements. Small public commitments make later larger commitments easier.

- **Use small yes-ladders.** Sign up → connect one tool → see one insight → upgrade. Each step is a small yes that makes the next one consistent with the user's chosen identity ("I'm a person who uses this tool").
- **Public commitment is stronger.** "Add to your team's roadmap" is stronger than "Save to your list."
- **Friction at the right moment.** Some friction (a confirmation step before deleting) leverages consistency to prevent regret.

**Concrete rewrite:**
- Onboarding step 1: "What's one thing you'd want this to do for you?" — text input, free-form. The user commits to a use case in their own words. Step 5: show that exact use case being solved.

**Manipulation line:** don't trap the user in a commitment they didn't understand. "By clicking continue, you agree to…" buried in 8-point gray is dark pattern, not consistency.

### 6. Scarcity (Cialdini)

Limited supply increases perceived value. Real scarcity is honest; manufactured scarcity is a tell.

- **Time scarcity must be real.** "Beta closes Friday" works if beta actually closes Friday. "Limited spots remaining" works if there's actually a cap.
- **Quantity scarcity must be falsifiable.** "Only 3 left at this price" works if a refresh shows the number decrement. A static "Only 3 left" on every visit reads as fake.
- **Honest scarcity often beats engineered urgency.** "We're a 4-person team and can only onboard 5 customers per week" is more credible than a countdown timer.

**Concrete rewrite:**
- Before: countdown timer that resets on refresh.
- After: "Currently onboarding 5 customers a week — next opening: week of Nov 18." If true, ship it. If false, don't.

**Manipulation line:** any timer, counter, or "only N left" that doesn't reflect real state is over the line. The smell test: would you bet $1000 that the number is true? If not, don't ship it.

### 7. Authority

Humans defer to credible authorities. Authority on a landing page = team credentials, customer caliber, third-party validation.

- **Team page over generic "About us."** Real photos + real backgrounds + real prior work ("previously: design lead at Stripe") beats stock photos and stock bios.
- **Press / podcast / write-up logos belong above the fold** if you've earned them ("Featured in TechCrunch, The Verge, Hacker News").
- **Credentials in the product matter.** A SOC2 badge, an open-source GitHub link with real stars, a public roadmap — these all signal "real thing built by real people."

**Concrete rewrite:**
- Before: "Built by a passionate team of engineers."
- After: "Built by Sarah (ex-Stripe), Jay (ex-Notion), and Maya (ex-Figma) — 14 years combined building B2B tools."

**Manipulation line:** every credential must be true and verifiable. "Featured in TechCrunch" when you weren't, or padding the team's resume, kills the entire site's credibility on first verification.

### 8. Choice architecture (Thaler & Sunstein)

The number, order, and default-state of choices determines what the user picks. Too many choices = paralysis; the default option becomes the chosen option for most users.

- **Three options is the sweet spot for paid tiers.** Starter / Pro / Enterprise. Two feels limiting; four+ feels overwhelming.
- **Recommended tier should be visually distinguished.** Border accent, "Most popular" tag, slightly larger card.
- **Defaults are powerful.** Default-on for "send me product updates" gets 70%+ opt-in; default-off gets 8%. Choose the default that aligns with the user's interest, not just yours.
- **Sort by what helps the user, not by ARPU.** Sorting pricing by "most useful" (recommended in the middle) reads as helpful; sorting by "highest revenue first" reads as a sales floor.

**Concrete rewrite:**
- Before: 5-tier pricing table with "Most Popular" on the most expensive tier.
- After: 3-tier pricing — Starter / Pro (recommended, bordered, "Most popular") / Enterprise. Sort by usefulness for the median user.

**Manipulation line:** "dark pattern" defaults — pre-checked boxes for adding products to the cart, pre-checked "subscribe to all future emails," opt-out-by-mail-only — are over the line. The default should serve the user's interest, not punish them for being passive.

---

## Concrete examples

### Example A — Pricing page rewrite

Before (the "everything wrong" version):

```
Free            $9/mo            $29/mo            $99/mo           Enterprise
                                                                    (Contact us)
Basic features   More features    All features      Pro + extras    Custom
[Sign up]        [Choose Plus]    [Choose Pro] ★    [Choose Max]    [Talk to sales]
                                  ★ Most Popular
```

Five tiers, "Most Popular" anchored on the cheapest paid tier, no real differentiation in features, contact-us hidden on the right.

After (anchoring + choice architecture + social proof applied):

```
Enterprise              Pro                          Starter
Custom                  $99/mo                       $29/mo
                        ★ Most Popular
                        — chosen by 78% of teams
For 50+ seat teams.     Everything Starter has,      For a single team.
SOC2, SSO, dedicated    plus shared workspaces,      Includes the core
support, custom         audit log, Slack integration,review workflow and
contract terms.         and priority email support.  unlimited reviews.
[Talk to sales]         [Start 14-day Pro trial]     [Start with Starter]
```

What changed:
- Three tiers (choice architecture).
- Enterprise on the left (anchor highest).
- Pro in the middle, distinguished with border + "Most Popular" tag + real social proof number.
- Concrete features, not adjectives.
- CTAs differentiated: "Talk to sales" / "Start trial" / "Start with Starter" — verbs match commitment level.

### Example B — Hero headline rewrite

Brief: a vendor-review tool for procurement teams. Current hero copy reads:

> **Empower your procurement team with AI.**
> Streamline vendor reviews and unlock faster decisions.
> [Get started for free]

Every principle is missing. AI-slop tells everywhere ("empower," "streamline," "unlock"). No social proof, no loss frame, no specificity.

Apply loss aversion + specificity + social proof:

> **Stop losing 4 hours a week to vendor security reviews.**
> Maya Chen at Notion got that time back in two weeks — full vendor review in 12 minutes instead of 4 hours, same depth, same audit trail.
> [See Maya's setup] [Start a 14-day trial]

What changed:
- Loss frame ("stop losing 4 hours") with a real, specific number.
- Social proof in the subheadline — name, company, outcome.
- Two CTAs: one low-friction ("see the setup" — reciprocity, gives value first), one commitment-level ("start trial").

---

## Anti-patterns

- **Reaching for 8 principles on one page.** Stop. Pick 2–3 deliberate moves. Stacking everything reads as a scam landing page.
- **Reaching for a countdown timer.** Stop. Verify the timer reflects real state that resets on refresh would expose. If not, ship honest scarcity copy instead ("onboarding 5 customers a week — next opening Nov 18").
- **Reaching for "AI-generated testimonial cards" to fill the proof section.** Stop. Either find real customer quotes, or don't ship the proof section. Fake proof poisons the rest of the page.
- **Reaching for "loss aversion" without a real loss.** Stop. If the user genuinely doesn't lose anything, the frame is a lie. Use gain framing honestly instead.
- **Reaching for pricing tricks (decoy tier, hidden recurring charge, default-checked upgrade) to bump revenue.** Stop. These work once. The second time the user encounters the trick — when they get charged, when they read the receipt — they leave and tell others. Pricing manipulation has the worst LTV-to-trust ratio of any dark pattern.
