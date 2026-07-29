---
name: planning-day
description: Builds a realistic plan for the user's day or week from their calendar, tasks, and what's pending — ordered by priority and fit to available time. Use when the user asks to plan their day or week, asks "what should I work on", or wants help prioritizing.
trigger: /plan-day
---

# Planning the Day

Give the user a plan they can actually follow — anchored to their real calendar, honest about how much time exists, ordered by what matters.

## Method

1. **Pull the real schedule first.** Read today's/this week's calendar (connected Calendar tools) — meetings are fixed rocks; plan the gaps around them.
2. **Gather the open work.** Tasks, commitments from recent email (what the user owes people), anything flagged. Use the `tasks` surface and shared memory.
3. **Prioritize honestly.** Rank by deadline × importance. Be realistic about how much deep work fits between meetings — don't plan 8 hours of focus into a 3-meeting day.
4. **Sequence it.** Hard deadlines and prep-before-meeting first. Batch shallow work (email, replies). Protect any deep-work block the calendar allows.

## Output

```
## Today — <date>
**Fixed:** <meeting @ time>, <meeting @ time>

**Plan**
1. <before 10am> — <highest-priority task> (<why: deadline/prep>)
2. <11–12 gap> — <task>
3. <afternoon> — <batch: replies, small items>

**If time allows:** <nice-to-have>
**Watch out:** <tight transition / deadline today / prep needed for X meeting>
```

For a week view, lay it out by day with the same logic and flag the week's hard deadlines up top.

## Rules

- Don't over-pack. A plan the user blows past by 10am is useless. Leave slack.
- Call out conflicts and prep needs explicitly ("the 2pm needs the deck done by 1").
- This is a proposal — the user adjusts. Don't create calendar blocks or reminders without their OK.
