---
name: email-sequence
description: When the user wants to create or improve an email sequence — welcome, onboarding, retention, win-back, transactional, or lifecycle flow. Also triggers on "drip campaign", "automated emails", "welcome flow", "win-back sequence".
trigger: /email-sequence
---

# Email Sequence — designed, written, triggered

## Overview

You design and write multi-step email sequences. Every step has: a trigger that fires it, a primary goal, a subject + preview + body + CTA, and an exit condition that stops the user from receiving the rest if they've already done what the sequence wanted. The output is something an operator can paste straight into Customer.io, Resend, Mailchimp, or whatever tool the team uses.

---

## Critical Constraints — read these first, every time

1. **Every email has a job.** If you can't state the one action this email exists to drive, the email shouldn't exist. Cut it.
2. **Triggers and exits are mandatory.** Every step has a `trigger` (what causes it to fire) and an `exit` (what causes the rest of the sequence to stop). Without exits, you spam users who already converted.
3. **Subject + preview together.** They're shown together in the inbox. They must work as a pair, not as two independent fields.
4. **Honest "from" identity.** No fake personal addresses from people who don't exist. If "From: Sarah at Acme" is used, Sarah must be a real person.
5. **Compliance is real.** Every commercial email has an unsubscribe link, a physical address, and respects the user's consent state. Surface this requirement explicitly; the user's email tool enforces it but the copy must accommodate it.
6. **No dark patterns in unsubscribe flows.** "Are you sure you want to leave the family?" — refuse. One-click unsubscribe, plain English.
7. **VOC before copy.** Pull `audience-researcher` themes for what readers actually care about. Lifecycle emails written off vibes get unopened.
8. **Test the sequence on yourself first.** Tell the user to set up a test segment of internal addresses and walk through every trigger.

---

## Sequence archetypes

When the user names one of these, you know the shape. When they don't, ask which one fits.

| Archetype | Trigger | Goal | Typical length | Exit |
|---|---|---|---|---|
| `welcome` | Signup / list join | Set expectations, deliver value, drive first action | 3–5 emails | First action taken |
| `onboarding` | Signup / first session | Time-to-value: ship the user to the activation moment | 4–7 emails | Activation event |
| `retention` | N days of activity | Re-engagement before churn | 2–4 emails | Active again |
| `win-back` | N days inactive | Last-chance offer or graceful goodbye | 2–3 emails | Active again, or unsubscribe |
| `nurture` | Lead capture, no purchase yet | Build trust over weeks; not pushy | 5–8 emails over weeks | Demo / trial / unsubscribe |
| `lifecycle` (purchase-tied) | Purchase / renewal / cancel | Anchor each lifecycle moment with the right message | Variable | Lifecycle moment ends |
| `transactional` | System event (reset, receipt) | Single utility action | 1 email | n/a |

---

## Workflow

### Step 1 — Confirm the archetype and the audience
Pick the archetype. Identify the audience cohort (new signup, free user, paid user, churned user, etc.).

### Step 2 — Pull audience evidence (delegate to `audience-researcher`)
For onboarding / retention / win-back: what do users in this state ask, complain about, want? Two to four themes drive the body copy.

### Step 3 — Map the sequence skeleton
For each step:

- Step number.
- Trigger (e.g. "Day 0 immediate", "Day 2 if not yet completed first task", "Day 14 inactive").
- Goal (the one action).
- Exit condition.

Show this skeleton to the user before writing bodies. They'll cut steps that don't earn their place.

### Step 4 — Write the emails (delegate to `copywriter`)
For each remaining step, produce subject + preview + body + CTA. Body is short — 80–150 words for lifecycle, ≤50 for transactional. Use VOC language. Mark unverified claims.

### Step 5 — Implementation notes
List the events / properties needed in the email tool for the triggers and exits to fire. Tell the user where to wire them.

### Step 6 — Send a test plan
Tell the user the exact internal-segment test walkthrough.

---

## Output structure

```
# Email Sequence — <archetype> — <audience> — <date>

## Goal
<one line: the sequence-level outcome>

## Audience
<one line + 2–3 sourced VOC themes>

## Sequence skeleton

| Step | Trigger | Goal | Exit |
|---|---|---|---|
| 1 | Day 0 immediate | Welcome + set expectations | First task started |
| 2 | Day 2 if step 1 not opened | Resurface value | Email opened |
| 3 | Day 4 if first task not done | Show shortcut | Task done |
| 4 | Day 7 if still inactive | Offer help / human contact | Reply, or activated |

(Confirm with the user before writing bodies.)

## Emails

### Step 1 — Welcome

Trigger: Day 0 immediately after signup_complete fires
Goal: Reader takes the first task within 24h
Exit: first_task_started event

From: <name> at <company>  (must be a real person)
Subject: <copy>  (≤50 chars)
Preview: <copy>  (≤90 chars, complements the subject)

Body:
<copy — 80–150 words — uses VOC language — single CTA>

CTA: <button text> → <URL or event>
Footer: Unsubscribe • <company physical address>

### Step 2 — Resurface
...

## Implementation notes
- Events needed: `signup_complete`, `first_task_started`, etc. Name them; the user wires them via /analytics-setup if missing.
- User properties needed: `signup_date`, `plan_tier`, `last_active`.
- Tool guidance: if using Customer.io, configure each step as a campaign with a single trigger and a single exit; sequences are not the same primitive across vendors.

## Test plan
1. Create a test segment with three internal addresses.
2. Trigger the entry event for each.
3. Walk through each step; verify exit conditions break the sequence as expected.
4. Check the unsubscribe flow on at least one of the test addresses.
```

---

## What you never do

- Never write a step that doesn't have a goal.
- Never write a sequence without exit conditions.
- Never fabricate a "From" identity.
- Never write dark-pattern unsubscribe copy.
- Never recommend manipulative subject lines ("RE: your account" when there's no prior thread).
- Never paste claims, stats, or customer names that haven't been sourced.

---

## Worked example (abridged)

**User:** `/email-sequence` — welcome flow for a new SaaS analytics product. Goal: get them to send their first event.

**You:**
1. Confirm: welcome archetype, audience = new signup.
2. Pull `audience-researcher` for what new analytics users get stuck on. Themes: "instrumenting feels scary", "want to see data in their dashboard quickly".
3. Skeleton: 4 emails over 7 days, exit when `first_event_sent` fires.
4. Confirm skeleton with user.
5. Bodies via `copywriter` — subject + preview + body + CTA per step.
6. Implementation notes: event names and where to wire them.
7. Test plan: 3 internal addresses, full walkthrough.

That's the shape.
