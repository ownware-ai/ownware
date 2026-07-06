---
name: testimonial-design
description: 'Proof patterns — photo + name + role + measurable outcome — without the corporate-stock-photo trap. Four testimonial formats (hero quote, three-card row, longform with outcome number, video thumbnail). Use when the brief calls for social proof on a landing, pricing, or homepage. Skip for logo bars (those are not testimonials — see /hero-patterns). Skip if the user hasn''t collected real quotes yet — bad quotes shipped are worse than no quotes.'
trigger: /testimonial-design
---

# Testimonial Design — proof, not props

## Overview

Testimonials are the single highest-leverage piece of social proof on a landing page — and the single most-faked, most-stock-photographed, most-vaguely-written element on the average B2B site. Done right, a testimonial closes the deal. Done wrong, it actively erodes trust because the reader smells the fake. This skill is about the right.

The job: pair a real human face + a real name + a real role + a measurable outcome, in one of four layouts, with no padding language and no stock photography. Everything else is wallpaper.

---

## Critical Constraints — read these first, every time

1. **Real human photo OR no photo. No stock.** A close-up of a smiling person in a blue shirt from Unsplash actively erodes trust — readers have seen it 200 times. If the customer won't provide a headshot, ship the testimonial with a tasteful monogram (initials in a circle, accent background) instead. Monogram beats stock by a wide margin.
2. **Name + role + company — all three or none.** "Sarah J." with no role is a fake-smell tell. "Sarah Jenkins, Head of Operations, Plaid" reads as real. If the customer asked to be anonymous, write "Senior PM, Fortune 500 fintech" — keep the role and the company segment, drop the name. Never "Sarah" alone.
3. **One measurable outcome per quote.** "Saved time" = wallpaper. "Cut onboarding from 11 days to 2" = a sentence that prints money. The number is the load-bearing element; the rest of the quote is supporting context. If the customer hasn't given you a number, ask before publishing.
4. **Quote length: 60–80 characters for hero quotes, 120–180 for card-row, up to 280 for longform.** Beyond 280 the reader skims. Tighten ruthlessly — every word should pull weight.
5. **Never invent attribution.** "John D., Engineer" with no company and no real photo is worse than no testimonial at all. If you don't have the real reference, ship the page without testimonials and add them later. Empty space is honest; fake props are not.

---

## Framework — four testimonial formats

### Format 1: Single hero quote (60–80 chars)

A short, punchy quote serving as the hero or as a section break. Big type (32–48px), name+role beneath, optional photo to one side.

**Use when:** the quote itself is so good it carries the section. Best with a single bold claim ("We replaced four tools with this in a week").

### Format 2: Three-card row (120–180 chars each)

Three testimonials laid out as cards, each with photo + quote + name + role + company logo. Standard B2B move; works on every screen size.

**Use when:** you have three customers from three different segments and you want to show breadth.

### Format 3: Longform with measurable outcome (180–280 chars)

One full testimonial with a callout number (e.g. "47% faster onboarding") pulled out beside the quote. Used as a section on its own — not three-up.

**Use when:** the story is the proof. The number lives in the eye; the quote backs it up.

### Format 4: Video thumbnail with overlay quote

A 16:9 video thumbnail with a play button and a short overlay quote. Click expands to a 60–90s customer testimonial.

**Use when:** you have actual video and the customer is articulate. Don't fake this with a photo + a fake play button.

---

## Rubric — the fake-testimonial smell test

A testimonial fails the smell test if it ticks any TWO of these:

1. **Vague claim.** "Great tool" / "love it" / "saved us time" with no number.
2. **No real photo.** Stock smile, generic avatar, no monogram, or worse — a clip-art silhouette.
3. **No role.** Just a name. Or just a first name.
4. **No company.** "Engineer at a startup" is suspect; "Engineer at Linear" is real.
5. **Adjective-heavy.** "Amazing, transformative, game-changing" — that's marketing-team copy, not customer voice.
6. **No specific verb.** "Helps us a lot" vs. "Cut our deploy time from 9 minutes to 90 seconds."

Ship the smell test on every quote before it goes live. If it fails two, rewrite or pull it.

---

## Concrete examples

### Example 1 — three-card row done right

```html
<section data-cx-id="proof" class="proof">
  <h2>How teams use it</h2>
  <div class="proof-grid">
    <article class="proof-card">
      <p class="quote">"Cut onboarding from 11 days to 2. We stopped doing white-glove kickoffs."</p>
      <div class="who">
        <div class="avatar"><img src="./lena.jpg" alt="" /></div>
        <div>
          <div class="name">Lena Park</div>
          <div class="role">Head of CX · Ramp</div>
        </div>
      </div>
    </article>
    <article class="proof-card">
      <p class="quote">"Replaced four internal tools and one full-time role. The ROI argument took 15 minutes."</p>
      <div class="who">
        <div class="avatar mono" aria-hidden="true">MS</div>
        <div>
          <div class="name">Marco Silva</div>
          <div class="role">VP Engineering · Plaid</div>
        </div>
      </div>
    </article>
    <article class="proof-card">
      <p class="quote">"Our team uses it more than Slack. That was unexpected."</p>
      <div class="who">
        <div class="avatar"><img src="./priya.jpg" alt="" /></div>
        <div>
          <div class="name">Priya Raman</div>
          <div class="role">CTO · Linear</div>
        </div>
      </div>
    </article>
  </div>
</section>

<style>
  .proof { padding: 96px 5vw; background: var(--surface); }
  .proof h2 { font-size: 32px; letter-spacing: -0.01em; margin: 0 0 48px; text-wrap: balance; }
  .proof-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  .proof-card { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
  .proof-card .quote { font-size: 17px; line-height: 1.5; margin: 0 0 24px; text-wrap: pretty; }
  .who { display: flex; align-items: center; gap: 12px; }
  .avatar { width: 44px; height: 44px; border-radius: 50%; overflow: hidden; background: var(--accent); }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .avatar.mono { display: grid; place-items: center; color: var(--accent-fg); font: 600 14px var(--font-display); }
  .name { font-size: 14px; font-weight: 600; }
  .role { font-size: 13px; color: var(--muted); }
  @media (max-width: 900px) { .proof-grid { grid-template-columns: 1fr; } }
</style>
```

Two customers have real photos; Marco asked to be referenced without a headshot, so he gets a monogram. Every card has a specific outcome verb ("cut", "replaced", "uses it more than"). No "amazing", no "transformative".

### Example 2 — the same testimonial done wrong (annotated)

```html
<!-- BAD: vague claim, stock photo, no role, no number -->
<article class="proof-card">
  <p class="quote">"This product is amazing. It has truly transformed how we work."</p>
  <div class="who">
    <img src="./stock-smile-woman-blue-shirt.jpg" /> <!-- everyone has seen this exact photo -->
    <div>
      <div class="name">Sarah J.</div>
      <!-- no role, no company -->
    </div>
  </div>
</article>
```

Three smell-test failures: vague claim, stock photo, no role. The reader registers all three in under a second and trusts the page less, not more.

---

## Anti-patterns

- **Stock photography as customer photos.** Worse than no photo. Every reader who's spent 5 minutes on Unsplash will spot it.
- **First-name-only attribution.** "Sarah, Marketing" is fake-smell. Full name, role, company — or pull the quote.
- **Adjective-stacked quotes.** "Game-changing, transformative, intuitive" — that's marketing-team copy. Real customers say "saved 6 hours a week" or "now I sleep on Sundays".
- **Logo bar mislabeled as testimonials.** A row of customer logos is social proof, not a testimonial. Different section. Don't conflate.
- **Made-up quotes attributed to real people.** Legally risky, ethically dead, and you will get caught when the customer's name appears beside something they never said. Always ship customer-approved language.
- **Testimonial slider that auto-rotates every 4 seconds.** Reader hasn't finished the first one. Either ship them as a static grid or ship a slider with manual controls only.
- **A 280-character quote on a hero. Or a 60-character quote on a longform feature.** Match the length to the format; the wrong length screams "we resized this from somewhere else".
- **Video thumbnail with a play button but no actual video on click.** Trust-killer; reader feels conned. Either ship the video or use a static format.
