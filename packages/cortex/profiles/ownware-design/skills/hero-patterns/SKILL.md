---
name: hero-patterns
description: 'Six landing-page hero compositions — centered classic, split text-image, full-bleed video, asymmetric editorial, terminal/dev, no-image typographic. Decision tree by brief (consumer→split, B2B→centered, dev→terminal, editorial→asymmetric). Layout rules per pattern (text width, CTA placement, asset aspect). Use at the start of any landing page build, or when an existing hero feels wrong. Pairs with /artifact and /copy-refiner.'
trigger: /hero-patterns
---

# Hero Patterns — six compositions, pick the right one for the brief

## Overview

The hero is the highest-stakes block on any landing page: 80% of visitors never scroll past it, and the decision to bounce or stay happens in the first 2-3 seconds. Most failed heroes aren't bad CSS — they're the wrong PATTERN for the brief. A consumer-warmth product trying to use a B2B-credibility centered-stack reads as cold; a developer tool using a stock-photo split reads as marketing-y and fake.

Six patterns cover ~95% of landing-page heroes. This skill is the picker (decision tree by brief) + the rules per pattern (text width, CTA placement, hero asset aspect). After this skill, jump to `/artifact` for file shape, `/copy-refiner` for the words.

---

## Critical Constraints — read these first

1. **One primary CTA. Always.** The hero has ONE primary action. Secondary actions are visible but lower-weight (text link with arrow, or ghost button). Two primary CTAs of equal weight = the visitor picks neither.
2. **Headline is the load-bearing element.** 64-96px on desktop for marketing heroes. Fluid with `clamp(40px, 7vw, 76px)`. Letter-spacing -0.02em. `text-wrap: balance`. Max-width 14-20ch (NOT measured in pixels — measured in characters so the line break lands at a comma or natural pause).
3. **Subhead width = max 56ch.** Past 56 characters per line, the eye loses the next line. Body lead under the headline should never run the full container width.
4. **Hero CTA visible in viewport at 1280×720 minimum.** If the user has to scroll to find the primary action, the hero failed. Reduce headline size, reduce padding, or move CTA up.
5. **One hero asset, not three.** A single photo, illustration, video, or product screenshot. Not a collage. Not a grid. The hero is a single moment, not a portfolio.
6. **No stock-photo hands typing on a laptop.** Ever. (Lower-resolution rule of all AI-slop sweeps — see `/design-review-framework`.)

---

## Framework — the six patterns

### Pattern 1 — Centered Classic

**The default B2B credibility move.** Headline + subhead + dual CTA + (optional) trust logos, all centered on the page.

Use when:
- B2B SaaS where credibility > personality (Stripe, Linear, Vercel direction).
- The product's value prop is broad and abstract; the asset isn't strong enough to anchor the page.
- You want to demote the hero asset (or skip it entirely) and let typography carry.

Layout rules:
- Container max-width 880px (intentionally narrow). Center with `margin-inline: auto`.
- Eyebrow chip / "Now in beta" tag at top — 13px caps, muted, optional.
- Headline 64-96px, max 18ch, `text-wrap: balance`.
- Subhead 18-22px, max 56ch, `--cx-muted`, lead-line spacing.
- Dual CTA row, centered: primary filled + secondary ghost or text-link.
- (Optional) Trust strip below CTAs: "Trusted by [3-6 logos]" at 60% opacity.
- Vertical padding: 96-160px desktop, 56px mobile.

### Pattern 2 — Split Text-Image (60/40 or 50/50)

**The consumer warmth + product-led move.** Text on the left, hero asset on the right. The asset gets visible weight.

Use when:
- Consumer-facing or prosumer product where personality matters.
- The hero asset is strong enough to anchor (product screenshot with clear UI moment, photo with story).
- The brand wants to feel inviting, not corporate.

Layout rules:
- Two columns: text 50-60%, asset 40-50%. `grid-template-columns: 1.1fr 0.9fr; gap: 64px;`
- Text column: headline 56-72px (slightly smaller than centered because the column is narrower), max 14ch.
- Subhead 18-20px, max 48ch (narrower because column is narrower).
- CTA row left-aligned: primary + ghost.
- Hero asset aspect: 4:3 or 16:9 for product shots. 1:1 for photo-led. Never portrait (1:1.3+) in a horizontal split — it leaves dead space.
- Vertical padding: 80-120px desktop, 56px mobile.
- Mobile: stack to single column, text first, asset below. Asset becomes 16:9.

### Pattern 3 — Full-Bleed Video / Image Background

**The "moment" move — emotional, immersive, brand-led.** Hero content overlaid on a video or large image that fills the viewport.

Use when:
- Lifestyle brand, consumer product with strong visual identity (Apple, Patagonia, Tesla).
- The video/image carries the value prop ("this is what life with X looks like").
- The brief explicitly wants a cinematic feel.

Layout rules:
- Hero section: `height: 100vh; min-height: 640px;`. Background image/video covers full area with `object-fit: cover`.
- Overlay gradient: `linear-gradient(to bottom, rgba(0,0,0,0.4), rgba(0,0,0,0.1))` so text is readable against any image content.
- Headline + subhead + CTA centered or bottom-left, with text-shadow for contrast safety: `text-shadow: 0 1px 12px rgba(0,0,0,0.4);`.
- Text color: `#FFFFFF` (this is one of the few places pure white is acceptable, because the dark overlay reduces halation).
- Single CTA, filled, high contrast.
- Mobile: trim height to `70vh` or `min-height: 540px` to keep CTA reachable.

The risk: every video-bg hero looks the same. Differentiate with the asset choice (custom footage > stock), not the layout.

### Pattern 4 — Asymmetric Editorial

**The "magazine" / agency / brand-led move.** Deliberate imbalance — oversized headline on one side, sparse content on the other, with whitespace as a design element.

Use when:
- Creative agency, fashion drop, magazine, art-led brand.
- The brief explicitly wants "premium", "editorial", "considered".
- Restrained color palette + strong typography is the brand.

Layout rules:
- 12-column grid. Headline spans 7-8 columns. Subhead spans 4-5 columns offset right or below.
- Headline 96-160px on desktop (oversized), max 12ch, `letter-spacing: -0.03em`. Serif or display-serif preferred.
- Subhead 16-18px (small relative to headline — the contrast is the move).
- One asset: a single photo or illustration positioned asymmetrically (e.g. bottom-right column, breaking the page edge).
- CTA: text link with arrow OR a small ghost button. Big filled buttons fight the editorial restraint.
- Vertical padding: 120-200px desktop, 64px mobile. Editorial breathing room.

### Pattern 5 — Terminal / Dev-Aesthetic

**The "we serve the operators" move.** Hero feels like a terminal, IDE, or CLI moment. Monospace numerals, dark surface, code-as-art.

Use when:
- Developer tool, infrastructure product, CLI / API-first product.
- The audience self-identifies as power users.
- The brand can defensibly use dev language without it feeling appropriative.

Layout rules:
- Background: `--cx-bg` dark (or `#0D1117` GitHub-ish, `#1E1E2E` Catppuccin-ish).
- Headline: 56-72px, can be smaller because the visual interest is the code block.
- Code block component to the right or below:
  - Background `--cx-surface` slightly lifted from bg.
  - Top bar with three traffic-light circles + filename (`~/ownware/agent.json`).
  - Monospace code, syntax-highlighted (use simple span colors, not Prism for a single block).
  - Subtle inner highlight + rim glow (see `/dark-mode-craft` rule 6).
- CTA: "Install in 30 seconds" with `$ npx @ownware/install` in monospace styling.
- Optional: a typing-animation effect on the code (purposeful motion only — see `/design-review-framework` motion-intent rule).

### Pattern 6 — No-Image Typographic

**The "the words are the product" move.** Pure typography, no hero asset, oversized headline as the entire moment.

Use when:
- Brand identity is the message (e.g. a manifesto page, a launch announcement, a hiring page).
- The headline is good enough to carry the entire fold.
- You're confident no asset would add — every asset would subtract.

Layout rules:
- Container max-width 1200px, centered.
- Headline 120-200px on desktop (oversized). `clamp(64px, 16vw, 200px)`. `text-wrap: balance`.
- Subhead 20-24px, max 56ch, positioned UNDER the headline, with generous space.
- Single CTA, text link with arrow (not a button) — the typographic restraint extends to the action.
- Background: solid `--cx-bg`. No texture, no gradient, no ornament.
- Vertical padding: 160-240px desktop. The page breathes.

---

## Decision tree — pick by brief

| Brief keyword | First-pick pattern | Backup |
|---------------|---------------------|---------|
| "B2B SaaS", "credibility", "trust" | 1 — Centered Classic | 2 — Split |
| "Consumer", "warmth", "friendly", "product-led" | 2 — Split | 3 — Full-bleed |
| "Lifestyle", "brand", "cinematic", "premium consumer" | 3 — Full-bleed | 4 — Editorial |
| "Editorial", "luxury", "agency", "magazine" | 4 — Asymmetric Editorial | 6 — Typographic |
| "Developer tool", "API", "CLI", "infrastructure" | 5 — Terminal/Dev | 1 — Centered |
| "Manifesto", "launch", "hiring", "minimalist statement" | 6 — Typographic | 4 — Editorial |

When unsure: default to Pattern 1 (Centered Classic). It's the safest, hits "competent" cleanly, and survives any brand mid-flight.

---

## Concrete examples

### Example 1 — Same brief, three patterns

**Brief:** "Indie CRM for solo founders. Audience: bootstrappers who want a clean lightweight CRM without the Salesforce bloat. Pricing-focused, no enterprise lies. Want it to feel honest and capable."

**Option A — Pattern 1, Centered Classic** (default B2B credibility):

```html
<section class="hero hero-centered" data-cx-id="hero">
  <p class="eyebrow">Now in public beta</p>
  <h1>The CRM solo founders actually use.</h1>
  <p class="lead">No 14-step onboarding. No "talk to sales" wall. Just contacts, deals, and follow-ups — at $19/month.</p>
  <div class="cta-row">
    <a href="#signup" class="btn-primary">Start free for 14 days</a>
    <a href="#tour" class="btn-link">Watch the 90-second tour →</a>
  </div>
  <p class="trust">Used by 2,400+ solo founders. No card required.</p>
</section>
```

Trade-off: Safe. Doesn't communicate the personality of "indie" or "honest" specifically — could be any B2B tool.

**Option B — Pattern 2, Split Text-Image** (consumer warmth, product-led):

Text-left with the same headline. Product screenshot on the right showing the contact list with a real deal in flight. The visible UI carries the "actually use" promise.

Trade-off: Heavier asset requirement — you need a beautiful product screenshot. If the product itself isn't visually polished, the split exposes that.

**Option C — Pattern 6, Typographic** (manifesto move):

```html
<section class="hero hero-typo" data-cx-id="hero">
  <h1>A CRM<br/>for one.</h1>
  <p class="lead">Nineteen dollars a month. No "talk to sales." No 14 steps to first value. Built for solo founders who are tired of the enterprise theatre.</p>
  <a href="#signup" class="btn-link-big">Start free →</a>
</section>
```

Trade-off: Loud point of view. Resonates hard if the audience is tired of enterprise SaaS; alienates if they're not. Best when the founder has earned the right to a stance.

For this brief, my pick is **Option C** — the "honest and capable" line in the brief is asking for a stance, and Pattern 6 is the only one that delivers stance via composition.

### Example 2 — Pattern 5 (Terminal) for a developer tool

**Brief:** "API for sending transactional email. Audience: backend engineers at startups. Want to feel like a dev tool, not a marketing site."

```html
<section class="hero hero-terminal" data-cx-id="hero">
  <div class="hero-text">
    <p class="eyebrow">v1.0 — production ready</p>
    <h1>Email API. No SDK to learn.</h1>
    <p class="lead">curl-friendly REST. Idempotency keys. Webhook delivery receipts. 99.99% uptime in 18 months and counting.</p>
    <div class="cta-row">
      <a href="#docs" class="btn-primary">Read the docs</a>
      <a href="#dashboard" class="btn-link">View status →</a>
    </div>
  </div>

  <div class="hero-terminal-block">
    <div class="terminal-head">
      <span class="dot dot-red"></span>
      <span class="dot dot-amber"></span>
      <span class="dot dot-green"></span>
      <span class="terminal-title">~/your-app/send.sh</span>
    </div>
    <pre class="terminal-body"><code><span class="t-dim">$</span> <span class="t-cmd">curl</span> https://api.relay.dev/v1/send <span class="t-flag">\</span>
  <span class="t-flag">-H</span> <span class="t-str">"Authorization: Bearer $RELAY_KEY"</span> <span class="t-flag">\</span>
  <span class="t-flag">-H</span> <span class="t-str">"Idempotency-Key: order-1284"</span> <span class="t-flag">\</span>
  <span class="t-flag">-d</span> <span class="t-str">'{"to":"a@b.com","template":"receipt"}'</span>

<span class="t-dim">→</span> <span class="t-ok">{"id":"msg_3a9","status":"queued"}</span></code></pre>
  </div>
</section>

<style>
.hero-terminal {
  background: var(--cx-bg);
  padding: clamp(64px, 10vw, 120px) clamp(24px, 4vw, 48px);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 64px;
  align-items: center;
  max-width: 1280px;
  margin-inline: auto;
}
.hero-text h1 {
  font-size: clamp(40px, 6vw, 64px);
  line-height: 1.1;
  letter-spacing: -0.02em;
  text-wrap: balance;
  margin: 0 0 16px;
  color: var(--cx-fg-strong);
}
.hero-text .lead {
  font-size: 18px;
  color: var(--cx-muted);
  max-width: 48ch;
  margin: 0 0 32px;
}
.hero-terminal-block {
  background: var(--cx-surface);
  border-radius: 10px;
  font-family: var(--cx-font-mono, ui-monospace, JetBrains Mono, monospace);
  font-size: 13px;
  line-height: 1.6;
  overflow: hidden;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.06),
    0 0 0 1px rgba(255,255,255,0.08),
    0 12px 32px rgba(0,0,0,0.50);
}
.terminal-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px;
  background: rgba(255,255,255,0.03);
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.dot { width: 10px; height: 10px; border-radius: 50%; }
.dot-red { background: #FF5F56; }
.dot-amber { background: #FFBD2E; }
.dot-green { background: #27C93F; }
.terminal-title { margin-left: 8px; color: var(--cx-muted); font-size: 12px; }
.terminal-body { padding: 20px 22px; margin: 0; color: var(--cx-fg); overflow-x: auto; }
.t-dim { color: var(--cx-muted); }
.t-cmd { color: #8779E8; }   /* violet — commands */
.t-flag { color: var(--cx-muted); }
.t-str { color: #58BFCC; }   /* teal — strings */
.t-ok  { color: #4ADE80; }   /* green — success */

@media (max-width: 880px) {
  .hero-terminal { grid-template-columns: 1fr; }
}
</style>
```

Pattern 5 delivers the brief: developer-spoken, no marketing-speak in the asset (the code IS the asset), and the design itself says "we serve operators."

---

## Anti-patterns

- **Stock-photo hands typing on a laptop.** AI-slop sweep blocker. Custom photography or product-real screenshots only.
- **Two primary CTAs side by side, same weight.** Visitor picks neither. One filled CTA + one ghost/text-link.
- **CTA below the fold on 1280×720.** The visitor can't act without scrolling. Trim padding or reduce headline size.
- **Headline running 90 characters wide.** Past 65ch the line break is unreadable. Cap at 14-20ch with `text-wrap: balance`.
- **Three hero patterns mashed together.** Headline centered + asset on right + video background. Pick ONE. Mashups make every pattern weaker.
- **Pattern 4 (Editorial) used for a B2B SaaS.** Reads as "the agency designed this, but the product doesn't match." Editorial is for brands that earn editorial, not for default credibility plays.
- **Pattern 6 (Typographic) with weak copy.** This pattern is 100% words. If the headline isn't dense enough to carry the page alone, use Pattern 1 with a small asset as backup.
- **Pattern 3 (Full-bleed video) with stock footage.** Defeats the entire move. The point of full-bleed is bespoke. Stock footage in full-bleed reads as "we couldn't afford to shoot custom."
- **Hero asset that doesn't show the product.** Decorative abstract gradients, hand-drawn illustrations that don't communicate anything specific, AI-generated images — all generic. Show the product or show something that earns the page.
- **Trust strip with 12 logos.** 4-6 logos max. Beyond that the strip becomes noise; pick the most recognizable.
