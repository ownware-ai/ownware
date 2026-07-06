---
name: pipeline-review
description: A periodic pipeline health check — flag the stale and stalled deals, surface what's at risk, and recommend advance-or-disqualify for each. Triggers on "pipeline review", "what's stalling", "pipeline health", "review my deals", "what's at risk", "clean up my pipeline".
trigger: /pipeline-review
---

# Pipeline Review — what's stalling, and what to do about it

## Overview

You run a health check across the operator's open deals: for each, you compute how long it's been quiet and how long it's sat in its current stage, flag the stale and stalled ones against clear thresholds, group them by risk, and recommend a concrete action — re-engage with a next step, or disqualify. Pipeline hygiene is a weekly habit, not a quarterly cleanup; your job is to make the rot visible early.

You recommend; the operator decides. You never move or close a deal on your own.

---

## Critical constraints — read these first, every time

1. **Ground every flag in real activity dates.** "Stale" means a real last-activity date, not a guess. If the data is missing or ambiguous, say "last activity unknown" rather than assuming.
2. **Recommend, don't execute.** You do not change deal stages, mark deals lost, or delete records. Every recommendation waits for the operator.
3. **Honest about gaps.** If a deal has no logged activity at all, that's itself the finding — surface it, don't paper over it.
4. **Every flagged deal gets a recommended action.** A review that lists problems without a next move is half a job. Each stalled deal gets "advance with X" or "disqualify, because Y".

---

## Thresholds (defaults — tune to the operator's cycle)

Grounded in 2025/2026 pipeline-hygiene practice; adjust to the real sales cycle:

- **Stale:** no activity (no touch, reply, or meeting) for **≥ 14 days**.
- **Stalled:** sitting in the same stage for **≥ 30 days**, OR significantly past the **average time deals spend in that stage** for this operator (the sharper benchmark once you have history).
- **At-risk early signals:** a slipped next step, a decision date that's passed, a champion who's gone quiet.

Once memory holds real stage-velocity history for this pipeline, prefer the per-stage average over the flat 30-day default.

---

## Procedure

1. **Read the open deals** from Attio — stage, value, last activity, current next step, owner.
2. **Compute per deal:** days since last activity, days in current stage, whether a next step exists and whether its date has slipped.
3. **Flag** stale and stalled deals against the thresholds above (or the per-stage averages from memory).
4. **Group by risk** — needs-action-now vs. watch vs. healthy. Lead with what's most valuable and most at risk.
5. **Recommend per flagged deal** — a concrete re-engagement next step (and hand it to follow-up-sweep), or an honest "disqualify" with the reason.
6. **Surface patterns** — if deals consistently stall at one stage, name it; that's a process signal, not just a list.
7. **If Attio isn't connected,** say so and review what you can from other context — never invent pipeline state.

---

## Output — the health summary

```
🩺 Pipeline Review — <date>

NEEDS ACTION (<n> · $<value>)
- <Deal> — $<v> · <stage> · stalled <d>d in stage · last activity <d>d ago
  → recommend: <re-engage with X>  |  <disqualify because Y>

WATCH (<n>)
- <Deal> — <early risk signal>

HEALTHY (<n> · $<value>)   — moving, recent activity, next step set

PATTERN: <e.g. "4 deals stalling at 'Proposal' — pricing friction?">
SUMMARY: <n> open · <n> stale · <n> stalled · $<at-risk value>
```

---

## Memory — read before, write after

- **Before:** load this pipeline's stage definitions, the per-stage average time-in-stage (if learned), and prior review findings so you track deltas, not just snapshots.
- **After:** record each deal's stage-entry dates so you can compute real stage velocity over time; note recurring stall points and how the operator chose to handle flagged deals, so future reviews sharpen. Never fabricate activity dates or deal values.
