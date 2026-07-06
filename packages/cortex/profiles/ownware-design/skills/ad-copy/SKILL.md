---
name: ad-copy
description: 'Write paid social and search ad creative — headlines, primary text, descriptions, CTAs — with character limits, hook frameworks, and platform-specific format rules. Use when drafting Meta/Google/LinkedIn ads, iterating on a campaign, or rewriting weak ad copy. Skip for long-form landing copy (use /psychology-applied or /artifact) or organic social posts (different game).'
trigger: /ad-copy
---

# Ad Copy — write the thing that earns the click

## Overview

Ad copy is different from landing copy: smaller space, hostile attention, paid placement, measurable by CTR and CPA. This skill is the operator's manual: hook frameworks, character limits per platform, the 5-variant rule, and how to write copy that survives the feed scroll. Output is `writeFile`'d as one campaign per file — headline variants + primary text variants + description variants + CTA variants, ready to paste into the ad manager.

For long-form persuasion (landing page copy, sales emails), use `psychology-applied`. For organic content (tweets, LinkedIn posts), that's a different motion — this skill won't help.

---

## Critical Constraints — read every time

1. **Always ship 5 headline variants minimum.** Not 1, not 3. Ad platforms optimize on at least 4–5 variants and the algorithm needs the input. Same for primary text (3 variants).
2. **Character limits are hard ceilings, not aspirations.** Going over kills the ad. Memorize them per platform — they're listed below. Truncation indicators ruin CTR.
3. **Lead with the hook in the first 3 words.** The user scrolls past in <2 seconds. The first 3 words decide whether they pause. "Save time" doesn't earn a pause; "4 hours back" does.
4. **One job per ad.** Awareness OR consideration OR conversion. Mixing destroys CTR. Pick one and write to it.
5. **Specificity beats cleverness every time.** "Maya at Notion got 4 hours back per week" beats "Reclaim your time" in any A/B test, ever.
6. **No claims you can't back up.** "Trusted by 10,000+ companies" requires the actual number. "Used by Stripe" requires Stripe being a real customer. False claims trip ad platform reviews and tank account standing.
7. **Audit for category clichés.** Use `web_search` to read 5 competitors' ads in the same category before writing. If your draft sounds like theirs, rewrite — the slot is to differentiate, not blend.

---

## Platform character limits (memorize)

### Meta (Facebook + Instagram feed/reels)

- **Primary text:** 125 chars before "See more" truncation. Hard cap 2200.
- **Headline:** 27 chars on mobile feed, 40 hard cap.
- **Description:** 27 chars visible, 30 cap.
- **CTA:** picked from a fixed dropdown — Sign Up / Learn More / Shop Now / Get Quote / Download / Contact Us / Apply Now / Book Now / etc.

### Google Search ads

- **Headline:** 30 chars × up to 15 variations. Google rotates them.
- **Description:** 90 chars × up to 4 variations.
- **Path (vanity URL segment):** 15 chars × 2.
- **Sitelinks (additional clickable lines):** 25 char title, 35 char description × 2.

### LinkedIn sponsored content

- **Intro text:** 150 chars before "...see more". Hard cap 600.
- **Headline:** 70 chars.
- **Description:** 100 chars (only shows on right-rail desktop).
- **CTA:** dropdown — Learn More / Sign Up / Register / Download / Subscribe / Apply.

### X (Twitter) promoted posts

- 280 chars total. The hook is the first 7 words because the rest is "..."'d in some placements.

### TikTok / Reels in-feed

- **Caption:** 100 chars visible, 2200 cap.
- The first second of the video IS the hook — copy hooks the curious tap.

---

## The 6 hook frameworks

Pick one per variant. Don't mix them within a single ad — pick the framework that matches the audience's pain point, then write the variant entirely in that frame.

### 1. The Specific-Outcome Hook

Lead with a concrete, measurable result.

- "4 hours back per week."
- "$2,400 saved on vendor reviews last month."
- "12-minute vendor check vs 4-hour spreadsheet drag."

**Why it works:** specificity is credible; vague benefit-claims are background noise.

**Use when:** you have a real customer outcome you can name and cite.

### 2. The Antagonist Hook

Name the enemy — the tool, process, or status quo the audience already resents.

- "Spreadsheets aren't security review tools."
- "Stop opening 14 tabs to evaluate a vendor."
- "Your procurement team isn't a copy-paste team."

**Why it works:** instant pattern-match. The audience nods before they read line 2.

**Use when:** there's a clear, widely-disliked status quo. Don't use against a specific competitor by name — leads to ad rejection and looks petty.

### 3. The Curiosity Gap Hook

State an observation that demands explanation.

- "Notion's procurement team reviews vendors in 12 minutes. Here's how."
- "The 4-hour vendor review is a habit, not a requirement."
- "Most security checklists are theater. This one isn't."

**Why it works:** the brain hates an unresolved sentence and pays the click to complete it.

**Use when:** you have a real story or finding the click can deliver. NEVER use as bait — if the click lands on a generic page, CTR collapses next round.

### 4. The Identity Hook

Name the audience by who they ARE, not what they do.

- "If your job is 'making sure we don't get breached because of a vendor' — this is for you."
- "For procurement leads who refuse to be the slowest team in the company."
- "Built for the engineer who got handed compliance as a 'side project.'"

**Why it works:** self-identification is the fastest form of qualification. Right reader self-selects in.

**Use when:** the audience has a strong professional identity (engineers, procurement leads, founders, ops people).

### 5. The Social Proof Hook

Open with the proof.

- "Stripe, Figma, and Linear run vendor reviews here."
- "Maya Chen (Notion) — '4 hours of vendor review work back, every week.'"
- "1,247 procurement teams switched in the last 60 days."

**Why it works:** humans defer to peer behavior. Strongest framework if the proof is real and the names are recognizable to the audience.

**Use when:** the names/numbers are true and the audience would know them. Drop this framework if your proof is generic ("trusted by thousands").

### 6. The Reframe Hook

Take a common assumption and flip it.

- "Vendor reviews aren't a security task. They're a leverage task."
- "The bottleneck isn't your security team. It's your form."
- "Compliance shouldn't be the slowest team. We made it the fastest."

**Why it works:** reframes are memorable because they require a small mental shift. The reader thinks about the ad after scrolling past.

**Use when:** you can defend the reframe in the landing page. If the ad's reframe is bigger than the product's payoff, CTR will be high and conversion will be terrible.

---

## The variant matrix — what to ship per campaign

For each ad set, write:

- **5 headlines** — each using a different hook framework (so the platform can optimize for which hook this audience responds to).
- **3 primary text variants** — short (≤80 chars, mobile-feed-friendly), medium (~150 chars, fits LinkedIn intro), long (~400 chars, with the full pitch for high-intent surfaces).
- **3 description variants** — different angles on the same offer (price, speed, social proof).
- **3 CTA pairings** — different CTA from the dropdown, paired with how the rest of the ad is written. "Learn More" pairs with curiosity; "Sign Up" pairs with specific-outcome; "Book Now" pairs with urgency.

Total per campaign: 14 lines of copy. Costs you 20 minutes. Saves a week of bad delivery.

---

## File shape — one campaign, one file

`writeFile` the campaign as a markdown file. The marketer copies straight into the ad manager. No prose preamble — they don't need it; they need ready-to-paste text.

```markdown
# Campaign: Vendor review tool — Q4 launch
# Audience: B2B procurement leads, US, 50-500 employee SaaS companies
# Platform: Meta (FB + IG feed), LinkedIn sponsored content
# Date: 2026-11

---

## Meta — primary text variants

### Variant A (specific-outcome, 80 chars)
4 hours back per week. Vendor reviews in 12 minutes. Same audit trail.

### Variant B (social-proof, 145 chars)
Maya at Notion gets 4 hours of vendor-review time back every week. Same audit depth, same checklist, 12 minutes instead of 4 hours.

### Variant C (antagonist, 380 chars)
Spreadsheets aren't security review tools. They're slow, error-prone, and the auditors hate them as much as you do. We built a vendor review tool that lives where your procurement workflow already lives — Slack, your ticket system, your contract repo. 12-minute review, full audit trail, same depth as your 4-hour version. Started by 1,247 procurement teams in the last 60 days.

## Meta — headline variants (27 char target, 40 max)

1. 4 hours back per week
2. Vendor reviews in 12 min
3. Notion did it. So can you.
4. Made for procurement leads
5. Stop the 4-hour review

## Meta — description variants (27 char target)

1. 12-min vendor review tool
2. Used by Notion + Stripe
3. Full audit trail, faster

## Meta — CTA pairings

- Headline 1 ("4 hours back") + CTA "Learn More" (curiosity earns the click)
- Headline 2 ("Vendor reviews in 12 min") + CTA "Sign Up" (specific outcome → commit)
- Headline 3 ("Notion did it.") + CTA "Book Now" (social proof → action)

---

## LinkedIn — intro text variants (150 char target)

### Variant A (identity hook)
For procurement leads tired of being the slowest team in the company. 12-minute vendor review, same audit trail. Notion's team got 4 hours back per week.

### Variant B (reframe hook)
Compliance shouldn't be the slowest team. We rebuilt vendor reviews so they take 12 minutes — full audit trail, same depth — and your team gets the rest of the day back.

### Variant C (specific-outcome + social proof)
Maya at Notion does vendor reviews in 12 minutes. Same checklist as the 4-hour version. Same audit trail. Built for procurement leads at SaaS companies.

## LinkedIn — headlines (70 char target)

1. Vendor reviews in 12 minutes. Same depth. Same audit trail.
2. The procurement tool Notion, Stripe, and Linear use for vendor reviews
3. Reclaim 4 hours a week from vendor security reviews

---

## Google Search — Ad Group: "vendor management software"

### Headlines (30 char each, 15 max)
1. Vendor Reviews in 12 Min
2. Procurement, Without Spreadsheets
3. Used by Notion + Stripe
4. 4 Hours Back Per Week
5. SOC2-Ready Vendor Reviews
6. Built for Procurement Leads
7. Vendor Security, Faster
8. Full Audit Trail in Minutes

### Descriptions (90 char each, 4 max)
1. Maya at Notion gets 4 hours back per week. Same audit trail, 12 minutes per review.
2. Stop using spreadsheets for security reviews. Built for procurement leads at SaaS firms.
3. Used by 1,247 procurement teams in the last 60 days. SOC2-ready audit trail in 12 min.
4. Vendor review tool with full audit trail. Same depth as your 4-hour version, faster.

### Sitelinks
- Title: "See Maya's setup" (25 cap) / Desc: "How Notion runs vendor reviews in 12 min" (35 cap)
- Title: "Read the SOC2 brief" (25 cap) / Desc: "Audit-ready trails out of the box" (35 cap)
```

That's a deliverable. The marketer copies, pastes, ships.

---

## Concrete examples

### Example A — Rewriting a weak ad

Existing ad (from `web_search` competitor scan):

> **Empower your procurement team with AI-powered vendor management. Streamline workflows and unlock business value. Trusted by thousands.**
> [Learn More]

Every framework is missing. AI-slop language ("empower," "streamline," "unlock," "AI-powered"), no specificity, no social proof, no hook in the first 3 words.

Rewrites (5 variants, each in a different framework):

1. **(Specific-outcome)** "4 hours back per week. Same audit trail."
2. **(Antagonist)** "Spreadsheets are not security review tools."
3. **(Curiosity)** "Notion's vendor review takes 12 minutes. Here's how."
4. **(Identity)** "Built for procurement leads who refuse to be the slowest team."
5. **(Social proof)** "Stripe, Figma, and Linear's vendor reviews live here."

Notice: every rewrite ditches "empower / streamline / unlock / trusted by thousands." Replaces with a concrete claim, a named customer, or a clear stance.

### Example B — Campaign for a consumer fitness app

Brief: a habit-tracking app for runners. Target: first-time marathon trainees.

Audience research via `web_search`: competitor ads are heavy on "Transform your run" / "Unlock your potential" / generic stock-photo runners. Slop everywhere.

Headlines (5 variants):

1. **(Specific-outcome)** "From 5K to your first marathon in 18 weeks."
2. **(Antagonist)** "Your training plan shouldn't be a spreadsheet."
3. **(Curiosity)** "Why most first-time marathoners quit at week 7. (And how to not.)"
4. **(Identity)** "For runners signing up for their first marathon in 2027."
5. **(Reframe)** "Marathon training is a calendar problem, not a willpower problem."

Primary text (3 variants):

- **Short (80 chars):** "First marathon? 18 weeks. We'll tell you exactly what to run each day."
- **Medium (145):** "47% of first-time marathoners quit at week 7 (the long-run wall). Our plan adapts when you miss a run instead of dropping you."
- **Long (400):** "First-time marathoners quit at week 7 because they miss two long runs and their plan tells them to do the same thing the next week. Ours adapts. We're built for the runner who's never done 26.2, who can't run on the weekends sometimes, who needs a plan that bends without breaking. 18 weeks, full daily plan, paces adjusted by your last 4 runs. Free for the first 4 weeks."

---

## Anti-patterns

- **Reaching for "Empower your X with AI" or any variation.** Stop. Every category has this ad. Read your competitors' first via `web_search` — your draft will sound exactly like theirs. Pick a different hook.
- **Reaching for 1 headline and 1 primary text.** Stop. Platforms optimize on variants. 1 headline = no optimization = wasted spend. Ship 5/3/3.
- **Reaching for a generic stock-photo CTA copy block.** Stop. "Get started today!" is filler. Pair the CTA to the hook ("See Maya's setup" / "Read the SOC2 brief" / "Start the 18-week plan").
- **Reaching for a claim you haven't checked.** Stop. "Trusted by 10,000+ companies" needs the actual number. If you don't have it, write a different headline. Ad platforms (esp. Meta and Google) will reject claims they detect as unsupportable.
- **Reaching for a hook that the landing page can't deliver on.** Stop. The ad and the landing are one piece. A "12-minute vendor review" ad that lands on a generic homepage with no demo flow CTR-spikes once and then dies. Match the ad's specificity to the landing page's specificity.
- **Reaching for "we'll AB test which works."** Stop. AB-test variants of the same hook framework, not random copy. AB-testing a specific-outcome headline against an antagonist headline tells you which framework this audience responds to. That's the test that compounds. Random rewrites are noise.
