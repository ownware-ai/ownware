---
name: triaging-inbox
description: Scans the user's inbox and sorts it into what needs action, what's waiting on them, and what's noise — with suggested next steps. Use when the user asks to check, clear, triage, or catch up on their inbox or email.
trigger: /triage-inbox
---

# Triaging Inbox

Turn a full inbox into a short, ranked action list. The user wants to know "what actually needs me?" — not a reprint of every email.

## Workflow

```
- [ ] Pull recent unread/important mail (connected Gmail tools)
- [ ] Group: Needs reply · Needs a decision · FYI · Waiting on others · Noise
- [ ] Rank by urgency × importance (deadlines, senders who matter)
- [ ] For each action item, propose the next step
- [ ] Present the short list — do NOT act without the user's go-ahead
```

## Sorting rules

- **Needs reply** — a person is waiting on the user's words. Highest priority; note who and the open ask.
- **Needs a decision** — requires the user to choose/approve, not just reply.
- **Waiting on others** — the user already acted; flag if it's overdue for a nudge.
- **FYI** — read-and-archive; summarize in one line each, batched.
- **Noise** — newsletters, receipts, automated. Mention the count, don't itemize.

Surface deadlines explicitly. A "needs reply" with a Friday deadline outranks an older one with none.

## Output

```
## Needs you (N)
1. **<sender>** — <one-line ask> · <deadline if any> → suggested: <reply / decide / forward>
2. ...

## Waiting on others (N)
- <who> on <what> — <X days> → nudge?

## FYI (N) — batched
- <one line> · <one line> · ...

## Noise: <count> (newsletters/receipts) — archive all?
```

End with: "Want me to draft replies for the top items, or just archive the noise?" Drafting is fine; **sending, archiving, or deleting need the user's explicit OK** (external/destructive actions).

## Principle

Be the filter, not the firehose. If the inbox is 40 messages, the user should be able to act on the 4 that matter in two minutes.
