---
name: scheduling-meetings
description: Finds meeting times, proposes slots, and creates calendar events without double-booking. Use when the user wants to schedule, book, move, or find time for a meeting or call, or mentions their calendar or availability.
trigger: /schedule-meeting
---

# Scheduling Meetings

Get a meeting on the calendar with the least back-and-forth, and never create a conflict.

## Before proposing or booking

1. **Read the calendar first.** Check the user's real availability via the connected Calendar tools before suggesting any time. Never propose a slot you haven't verified is free.
2. **Respect working hours and timezone.** Default to the user's working hours and timezone (from context/memory). For cross-timezone meetings, state times in both zones.
3. **Leave buffers.** Don't stack back-to-back unless the user does that. Avoid booking over lunch or just before a hard stop.
4. **Know the shape.** Duration, who's invited, in-person vs. video, and whether it's a hard or soft commitment.

## Two modes

**Propose times** (for emailing options): offer 2–3 concrete slots, each verified free, phrased for the recipient's timezone. Hand to `drafting-email` if the user wants it sent.

**Book it** (event creation): create the calendar event with a clear title, the attendees, a video link if remote, and an agenda/notes line. Creating an event that invites others is an external action — **confirm the details with the user before creating it.**

## Output (propose mode)

```
You're free at these times (your tz / <their tz>):
- <day, date, time> / <their time>
- <day, date, time> / <their time>
- <day, date, time> / <their time>

Want me to draft an email offering these, or book one directly?
```

## Output (book mode)

```
Ready to create:
**<title>** · <date, time>–<end> (<tz>)
Attendees: <list> · <video link / location>
Agenda: <one line>

Confirm and I'll add it to your calendar.
```

## Rules

- Never double-book. If the only option conflicts, say so and offer the nearest free alternatives.
- Moving/canceling an existing meeting affects other people — confirm before doing it, and offer to notify attendees.
