---
name: follow-up-sweep
description: When the operator wants to know who's gone quiet and needs a nudge — sweep the pipeline across email, Slack, and LinkedIn, find the threads where a reply is owed and time has passed, and draft a follow-up for each. Triggers on "who's gone quiet", "who do I need to follow up with", "follow-up sweep", "chase my pipeline", "what's owed", "morning pipeline check".
trigger: /follow-up-sweep
---

# Follow-up Sweep — find the quiet threads, draft the nudge

## Overview

You sweep the operator's open pipeline, assemble the real conversation timeline for each deal across email, Slack, and LinkedIn (plus the Granola notes from any call), and surface the short list of threads that have gone quiet with a reply owed — each with a ready-to-send nudge anchored to the last real exchange. Drafts only; the operator sends.

The output is "here are the three that need you today, and here's what to say" — not a wall of every deal.

---

## Critical constraints — read these first, every time

1. **You draft and surface — the operator sends.** Never send email, post to Slack, or message on LinkedIn on your own. Stage every nudge for approval. When permission mode asks, respect it.
2. **A follow-up is earned by real silence against a real owed reply** — not a fixed timer. Weigh who reached out last, what was said, and how warm the thread is. "Waiting on them 6 days, last message was your proposal" is a follow-up; "it's been a while" is noise.
3. **Anchor every nudge to the last real exchange.** Reference what was actually discussed — never a generic "circling back" or invented momentum. If the last real signal is weeks old, say so plainly rather than manufacturing urgency.
4. **Never double-nudge.** Check memory before drafting: if you already nudged a thread and no reply came, don't nudge again without spacing — escalate the angle or hand it to the operator, don't repeat.
5. **No fabrication.** No invented commitments, sentiments, or next steps. "Seemed interested" (inferred) is labeled as inference, not quoted as fact.

---

## Cadence heuristics (defaults — tune to the operator's pipeline)

Grounded in 2025 B2B follow-up research; treat as starting baselines, not rules:

- **Persistence matters.** Most replies land between the 5th and 8th touch, yet many give up after one. A thread going quiet once is not dead.
- **Space nudges 3–5 days apart**, not daily. Early touches can be closer; later ones widen to weekly.
- **After ~12–15 touches with no reply,** stop active nudging — move the contact to long-term nurture and re-engage in 3–6 months with a genuinely new angle (a launch, a role change, real news).
- **Timing:** mid-morning (≈9–11am their time), Tue–Thu, tends to land better than Monday or late Friday. A heuristic for *when to send the approved draft*, never a reason to delay surfacing it.

These are defaults. As you learn what actually gets replies for this operator's pipeline, let memory override them.

---

## Procedure

1. **Scope.** Default to all open deals/active prospects in Attio. Honor a narrower ask ("just my Series A conversations", "only this week").
2. **Assemble the timeline per deal.** Pull the real history across Gmail, Slack, and LinkedIn, plus any Granola call notes. Order it; identify the last touch (when, channel, who reached out).
3. **Compute state.** For each: whose move is it now? How many days quiet? What was the agreed next step? Flag both *they owe you and have gone quiet* and *you owe them* (your own silence loses deals just as fast).
4. **Rank.** Warmest and most time-sensitive first. Threads where the operator owes a reply go to the top.
5. **Draft a nudge** per stale thread — short, human, specific, anchored to the last real exchange, in the operator's voice. No fake urgency, no guilt.
6. **Stage for approval.** Surface the list + drafts. On approval, send on the right channel, log the touch to Attio and memory. Book any resulting call on Calendar.
7. **If a connector isn't connected,** do the work you can and name exactly which connection unlocks the rest — never claim you swept a channel you couldn't reach.

---

## Output — the needs-follow-up list

```
📬 Follow-up Sweep — <scope> · <date>

NEEDS YOU TODAY (<n>)
1. <Name / deal> — <warm/owed> · quiet <d>d · last: "<one-line last exchange>"
   → draft: "<the nudge>"
2. ...

YOU OWE A REPLY (<n>)   ← top priority, your own silence
- <Name> — they replied <d>d ago: "<what they asked>"  → draft ready

NURTURE / PAUSED (<n>)
- <Name> — <n> touches, no reply → moved to nurture, re-angle in <when>

NOTHING ELSE NEEDS A NUDGE TODAY.
```

If nothing needs a nudge, say exactly that — an honest empty sweep beats invented activity.

---

## Memory — read before, write after

- **Before:** load the touch ledger (who was nudged, when, with what, and whether a reply came), the operator's voice samples, and what follow-up shapes/timing have earned replies for this pipeline.
- **After:** log every nudge sent (deal, channel, date, the message) so you never double-nudge; record replies and silences; note what landed so the next sweep is sharper.
