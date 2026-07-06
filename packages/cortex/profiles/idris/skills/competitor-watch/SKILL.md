---
name: competitor-watch
description: When the operator wants their competitors monitored on a cadence — pricing, features, funding, hiring, news — and a one-page "what changed and why it matters" with a heads-up if anything's urgent. Also triggers on "watch our competitors", "what changed with <competitor>", "weekly competitive update", "monitor the market".
trigger: /competitor-watch
---

# Competitor Watch — what changed, why it matters, sourced

## Overview

You run a monitoring pass over a fixed watch list of competitors, isolate what changed since last time, verify the load-bearing changes against primary sources, and deliver a one-page brief — what moved, the evidence and date, why it matters for the operator, and your confidence in each item. File the full sourced version in Notion, update the baseline in memory, and fire a Slack heads-up if something can't wait for the next cadence.

The value is the *delta* and the *so-what*, both defensible. A page the operator can forward to their board without editing out an overreach.

---

## Critical constraints — read these first, every time

1. **Every claim sourced and dated.** Price, feature, raise, hire — each carries where it came from and when you observed it. Markets move; an undated fact is a liability.
2. **Primary over secondary; verify what matters.** Before a change enters the brief as fact, confirm it against the primary source. Spawn `fact-checker` on the items that will drive a decision (a new price, a funding figure, a named exec hire).
3. **Deltas, not snapshots.** Diff against the stored baseline. Never re-report unchanged info as news; never miss a change because you only looked at "now."
4. **"Why it matters" or it's noise.** Each surfaced change gets a one-line implication for the operator's position. When something genuinely doesn't matter, say so — don't inflate noise to look busy.
5. **Confidence tiers, never laundered.** Confirmed (primary) / Reported (secondary only) / Inferred (signal-based, show reasoning). An inference dressed as fact is the most dangerous output you can produce.
6. **Public and authorized sources only.** No break-ins, no logins you weren't given, no pretexting.

---

## Inputs you collect (or read from context / memory)

- **Watch list** — the competitors. Read from memory if a list was set before; otherwise ask and store it.
- **Dimensions** — what to track per competitor. Default: pricing, features, funding, key hires, notable news.
- **Baseline** — the last-known state per competitor + the date of the last run, from memory.
- **Filing target + urgency channel** — where the brief lives (Notion/Drive) and where urgent heads-ups go (Slack).

If Notion/Drive/Slack isn't connected, produce the brief on disk and in chat, and tell the operator which connection unlocks filing/alerts — don't claim you posted it.

---

## Procedure

1. **Load baselines** for every target from memory, plus the date of the last run.
2. **Fan out.** Spawn one `target-researcher` per competitor and run them in parallel — each returns a sourced, dated brief on its single target across the requested dimensions. This is the whole reason the run is fast.
3. **Collect + isolate changes.** For each target, compare what came back to the baseline. Keep only what changed.
4. **Verify the load-bearing changes.** Spawn `fact-checker` on the changes that will drive a decision. Confirmed / Contradicted / Unverifiable, each with its source.
5. **Synthesize the one-pager** (format below). Keep it to a page — a brief no one reads failed.
6. **File + update.** Save the full sourced brief to Notion/Drive; update memory's baseline and append the change log with today's date.
7. **Route urgency.** If a change is time-sensitive (a competitor undercutting the operator's exact price, a launch onto their roadmap, a raise that changes the math), fire a Slack heads-up now.

---

## Output — the one-pager format

```
🔭 Competitor Watch — <date> · vs baseline <last-run date>

⚡ URGENT (if any)
- <competitor>: <change> — why it can't wait — [source, date] — confidence

WHAT CHANGED
<competitor>
  • <dimension>: <old → new> — why it matters — [source, date] — Confirmed/Reported/Inferred
<competitor>
  • No material change since <date>.

NO-CHANGE (one line): <competitors with nothing new>
GAPS: <what you couldn't confirm, stated as unknown>
```

The full version (every citation, every source URL) goes to Notion; the one-pager is the distilled view.

---

## Memory — read before, write after

- **Before:** load the watch list, per-target baselines, source-quality notes, and what this operator actually reacts to.
- **After:** update each target's baseline to the new observed state with today's date; append the change log; note any source that proved reliable or wrong. This is what lets the next run report deltas instead of starting from zero.
