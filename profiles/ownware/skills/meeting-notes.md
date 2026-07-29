---
name: meeting-notes
description: Turns raw notes or a transcript into clean meeting minutes — decisions, action items with owners, and follow-ups. Use when the user shares meeting notes or a transcript, or asks to write up, clean up, or capture a meeting or call.
trigger: /meeting-notes
allowedTools:
  - readFile
  - writeFile
---

# Meeting Notes

Turn messy input (a transcript, bullet scrawl, or the user's recollection) into minutes someone could read a week later and know exactly what happened and who owns what.

## Method

1. **Read the raw input fully** (`readFile` if it's a file the user points at).
2. **Extract structure**: what was discussed, what was decided, what's now owed by whom.
3. **Attribute action items.** Every action gets an owner and, if mentioned, a due date. An action item with no owner is a dropped ball — flag it: "owner unclear".
4. **Don't invent.** If the transcript doesn't say who'll do something, don't assign it — surface it as unassigned.

## Output

```
# <Meeting> — <date>
**Attendees:** <names> · **Duration:** <if known>

## Summary
<2–4 sentences: what this meeting was for and where it landed>

## Decisions
- <decision> — <rationale if given>

## Action items
- [ ] <owner> → <action> · due <date or "TBD">
- [ ] ...

## Discussion notes
- <topic>: <key points>

## Open / parking lot
- <unresolved item or deferred topic>
```

Offer to save it (`writeFile` to a notes file) and, if the user wants, to draft follow-up emails to action-item owners via `drafting-email`.

## Rules

- Minutes are a record, not a transcript — capture substance, cut the chatter.
- Preserve exact commitments and dates verbatim.
- If asked to share with attendees, that's an external action — confirm first.
