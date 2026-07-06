---
name: ads-intelligence
description: Pull competitor ads from public ad libraries, extract recurring hooks and visual patterns, and write a single-file HTML report with positioning recommendations for our campaign. Use when the user asks "what are competitors doing", "research the ad space", "teardown X's marketing", or before drafting a new ad-copy direction. Skip when there is no competitor to study or no campaign in flight — this is a research surface, not a generator.
trigger: /ads-intelligence
---

# Ads Intelligence — read the room before you write the copy

## Overview

Before drafting a new ad, you should know what the buyer has seen this week. Three competitor ads, read carefully, tell you the hooks the audience has been trained on, the messaging cliches saturated to the point of invisibility, and the *gap* your campaign can speak into. This skill is the workflow: identify competitors, pull live ad examples via `web_search` + `web_fetch`, synthesize patterns, write the report as a single HTML artifact, and end with a 3–5 line positioning recommendation.

The deliverable is a `competitor-teardown.html` artifact — same file shape as `artifact` — that the user can read in one scroll and the `ad-copy` skill can consume as input.

---

## Critical Constraints — read these first, every time

1. **3–7 competitors max per report.** Below 3 and the patterns aren't statistical; above 7 and the report is noise the user will skim. Five is the right count.
2. **3–5 ads per competitor.** Same logic — one ad is anecdote, five is a pattern.
3. **Public ad libraries only.** Facebook Ad Library (`facebook.com/ads/library`), TikTok Creative Center (`ads.tiktok.com/business/creativecenter`), LinkedIn ads (the company's "Posts" tab → "Ads"), Google Ads Transparency Center (`adstransparency.google.com`). No scraping private surfaces, no logging into competitor accounts.
4. **Cite every claim.** When the report says "competitor X leans on a fear-of-missing-out hook", link the ad URL or quote the exact line. Unsourced claims are speculation dressed as research.
5. **End with a recommendation, not a summary.** The user asks "what should we do?" not "what did you find?". The last section is *the move* in 3–5 lines.

---

## The workflow — 6 steps, in order

### Step 1 — name the competitors

If the user named them, use that list. If not, ask once: "Which 3–5 brands are you measuring yourself against?" Don't guess silently. If the user says "you pick", run `web_search` for "{category} top {audience} brands 2026" and surface the candidates back before pulling ads.

### Step 2 — locate ad libraries

For each competitor, run `web_search` with the queries below until you get a working library link. Order by quality: Facebook → TikTok → LinkedIn → Google.

- `facebook ad library {brand}` → returns the Meta Ad Library URL.
- `tiktok creative center {brand}` → returns the brand's TikTok ad page.
- `google ads transparency {brand}` → returns the Google library.
- `{brand} linkedin ads` → harder to find; fall back to the company's LinkedIn Posts tab and filter for "Promoted" badges.

### Step 3 — fetch 3–5 ad pages per competitor

Use `web_fetch` on each ad library URL. Capture the visible ad copy (headline, body, CTA), the format (single image, carousel, video), and where possible the impression range (Meta shows "1k–5k" buckets). Do not embed the ad image directly in the report — link to the source page.

### Step 4 — extract recurring patterns

For each competitor, jot 3 lists:

- **Hooks (the first line / opening).** "Tired of X?", "Founders who Y", "Now in beta".
- **Visual patterns.** Background color, photo vs illustration, product-in-hand vs lifestyle, type weight, density.
- **CTAs.** "Get demo", "Try free", "Book a call", "Read the post".

Then across all competitors, group hooks that repeat. The hooks appearing in ≥ 3 of your 5 competitors are *saturated* — your campaign should avoid them. The hooks appearing in 0 are either gaps (write into them) or red flags (the audience proven they don't respond).

### Step 5 — synthesize the positioning insight

A real insight has three parts:

1. **What everyone is saying.** "All 5 competitors lead with 'AI-powered'."
2. **What the audience is hearing under that.** "Buyers have seen 'AI-powered' so many times this quarter, it's now decorative — it doesn't trigger evaluation."
3. **The gap we can speak into.** "Lead with the *outcome*, not the *mechanism*. 'Close your books on day 2 of the month, not day 12.'"

If you can't write a real three-part insight, your pattern extraction wasn't deep enough — go back to Step 4.

### Step 6 — write the report as a single HTML artifact

File shape: same as `artifact`. `<!doctype html>` → `:root` tokens → component CSS → body with `data-cx-id` regions. Sections:

1. `data-cx-id="brief"` — one paragraph: who we are, who they are, the campaign in flight.
2. `data-cx-id="competitors"` — for each competitor: name, link, 3–5 ad samples (one card per ad with hook + body + CTA + link to source).
3. `data-cx-id="patterns"` — the recurring hooks (top 5–10), visual patterns, CTA grammar.
4. `data-cx-id="insight"` — the three-part insight from Step 5.
5. `data-cx-id="recommendation"` — 3–5 lines on the angle, hook, visual direction we should take.

Hand back through `writeFile` with the artifact handoff block from `artifact`.

---

## Concrete examples

### Example 1 — worked: synthesizing across 3 competitor ads

Suppose you're researching B2B finance tools for the Modern Treasury brief. You pulled these three Meta Ad Library ads:

- **Brex (live ad, Q1 2026):** "Stop chasing approvals." Body: "Spend controls that work like Slack." CTA: "Get a demo."
- **Ramp (live ad, Q1 2026):** "Save 5% on your spend in 90 days." Body: "Automated procurement for finance teams." CTA: "Calculate savings."
- **Mercury (live ad, Q1 2026):** "Banking for ambitious companies." Body: "Free for startups <$5M ARR." CTA: "Open an account."

**Pattern extraction:**

- Hooks: Brex = pain ("stop chasing"). Ramp = outcome with timeline ("5% in 90 days"). Mercury = aspiration ("ambitious").
- Visual: all three use product screenshots with a single accent color. None use stock photos of people. The visual language is "neutral surface, accent UI" — saturated.
- CTAs: each is a *low-friction* next step ("demo", "calculate", "open"). None say "buy" or "subscribe".

**Insight:**

1. What everyone's saying: control, savings, identity.
2. What buyers are hearing: "all three sound the same — they're all betting on the same three angles. The CFO has tuned them out."
3. Gap: nobody is talking about the *month-end close*. That's the actual pain — 40+ hours of reconciliation. Lead with the close, not the controls.

**Recommendation:** Lead with the close-the-books-in-two-days outcome. Visual: a literal calendar with day 2 circled, day 12 crossed out. CTA: "See your close timeline" (curiosity-driven, not commitment-driven). Avoid the words "control", "save", "ambitious" — those are the saturated terrain.

That's a real teardown. Three ads in, you have a positioning insight a copywriter can use tomorrow.

### Example 2 — the report's recommendation section, ready to paste

```html
<section data-cx-id="recommendation" class="recommend">
  <h2>Recommended angle</h2>
  <p class="lede">Skip "control", "savings", "ambition." Those slots are saturated.</p>
  <ol>
    <li><strong>Hook:</strong> "Close the books on day 2. Not day 12."</li>
    <li><strong>Visual:</strong> Calendar grid. Day 2 circled in accent. Day 12 crossed in muted red.</li>
    <li><strong>Body:</strong> "Modern Treasury automates reconciliation across your bank, ERP, and ledger. Your finance team writes 80% fewer JE entries."</li>
    <li><strong>CTA:</strong> "See your close timeline" — a calculator that asks for current close-day and returns the projected one.</li>
    <li><strong>Avoid:</strong> "AI-powered" (in 5/5 competitor decks), "control" (Brex's word), "save" (Ramp's word).</li>
  </ol>
</section>
```

That's the deliverable shape. Specific. Citable. The user knows what to do next.

---

## Anti-patterns

- **"AI-powered marketing automation"-style summaries that quote no specific ad.** Stop. Every claim links to a real ad or a real line. Unlinked summaries are speculation.
- **Pulling 50 ads to be "thorough".** Stop. After 25, you're not learning more — you're hoarding. 3–5 per competitor.
- **Skipping the "what we should do" section because "the user can decide".** Stop. The whole point of the report is to *recommend a move*. Decisions are the user's; recommendations are yours.
- **Embedding the actual competitor image into the report.** Stop. Link to the source page. (You don't have rights to redistribute, and a thumbnail is rarely what tells the story — the *copy* is.)
- **Using a generic "Top 10 advertising trends 2026" blog post in place of real ad data.** Stop. Those posts are themselves marketing. Pull live ads from the libraries.
- **Treating one viral campaign as a pattern.** Stop. One is anecdote. Repeated across 3 of 5 competitors is a pattern. Adjust language accordingly ("one competitor leans on X" vs "the category leans on X").
