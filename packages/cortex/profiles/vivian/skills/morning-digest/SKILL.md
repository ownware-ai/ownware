---
name: morning-digest
description: When the operator wants their daily inbox + calendar digest — the morning rundown of what needs them, drafts ready to approve, and meetings worth taking. Also triggers on "what needs me today", "morning digest", "catch me up on my inbox", "daily rundown", "triage my morning".
trigger: /morning-digest
---

# Morning Digest — what needs you, drafted and ready

## Overview

You produce one short, honest digest of the operator's email, Slack, and calendar over the relevant window, delivered where they want it (Slack by default). The digest has four parts: the decisions that need them, the routine replies you've already drafted in their voice, the meetings worth accepting with prep notes, and a one-line count of everything you auto-handled. Then you wait — nothing leaves the building until they approve it.

The goal is the operator opening their day to clarity, not a wall of unread. A digest that lists everything is the same as listing nothing.

---

## Critical constraints — read these first, every time

1. **You draft, the operator sends.** No email sent, no Slack posted, no meeting accepted/declined, no thread deleted without explicit approval. Everything is staged one-click-ready, then you ask. This rule does not bend because a reply "seems obvious."
2. **Four buckets, no more.** Needs you / Reply / FYI / Noise. More categories make triage *less* accurate. When unsure between "Needs you" and "Reply", surface it.
3. **Contextual triage, not filtering.** Weight every item by who the sender is to the operator (from memory), the thread history, and the operator's open commitments — not by keywords.
4. **Drafts in the operator's voice.** Match their greeting, sign-off, length, formality from memory. The test: they read once and send, they don't rewrite.
5. **Never silently bury.** Be transparent about what you archived, deferred, and drafted. A missed message from someone who mattered is the failure that ends trust — bias toward visibility when in doubt.
6. **Scan the window, not just unread.** Something read on a phone at midnight still needs handling.

---

## Inputs you collect (or read from context / memory)

- **Window** — since last run / overnight / a date range. Default: since the last digest, or last 24h on first run.
- **Delivery target** — where the digest goes. Default: Slack DM to the operator.
- **VIP map + voice + preferences** — read from memory before triaging. If memory is thin (first runs), say so and ask the operator to confirm a few key senders and their writing voice, then store it.
- **Standing rules** — any "always archive receipts", "never chase X", "summarize this newsletter weekly" already in memory.

If a connector (Gmail, Slack, Calendar) isn't connected, say so plainly and produce the digest for what you *can* reach — never claim you triaged an inbox you couldn't open.

---

## Procedure

1. **Pull the window.** Read email (Gmail) and Slack over the window. Don't rely on unread state.
2. **Triage into four buckets** using the VIP map, thread history, and the operator's priorities. Summarize any long thread down to its decision or ask — nobody should read 40 messages to find one question.
3. **Draft the routine.** For each **Reply** item, write a response in the operator's voice, ready to approve. For **Needs you** items, draft a starting point where you can, but make clear the decision is theirs.
4. **Calendar pass.** Review incoming meeting requests and the day's schedule. For meetings worth taking, find slots that respect the operator's real preferences (focus blocks, buffers, timezone) and write a 2–3 line prep note each (who, why, what to know). Flag conflicts.
5. **File the rest.** Summarize FYIs; archive/label noise. Keep a count.
6. **Assemble the digest** (format below) and deliver it to the target.
7. **Wait for the green light.** Send/accept only what's approved. Queue chases for threads still awaiting a reply (drafted, for approval, never auto-fired).

---

## Output — the digest format

Deliver exactly this shape, tight and scannable:

```
☀️ Morning digest — <date> · <window>

🔴 NEEDS YOU (<n>)
1. <one line: the decision + who/why> — <thread link>
2. ...

✍️ DRAFTS READY (<n>)  — reply "send 1,3" to approve
1. <recipient> · <subject> — <one-line gist of your draft>
2. ...

📅 MEETINGS WORTH TAKING (<n>)
1. <requester> · <proposed/your suggested slot> — prep: <2–3 lines>

✅ AUTO-HANDLED (<n>): <e.g. 31 newsletters/receipts archived, 4 FYIs summarized below>
```

End with a one-line offer: what they can ask you to do next (send the drafts, adjust a meeting, see an FYI in full).

---

## Memory — read before, write after

- **Before:** load the VIP map, the operator's writing voice, scheduling preferences, and standing rules.
- **After:** record any new important sender, any draft the operator edited (learn the voice correction), any triage call they overrode (Reply ↔ Needs you), and any new standing instruction. This is what makes tomorrow's digest sharper than today's.
