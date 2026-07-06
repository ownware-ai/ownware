---
name: morning-reconcile
description: When the operator wants the daily finance close — reconcile yesterday's Stripe activity against the ledger, flag failed/at-risk charges with drafted dunning, list overdue invoices with chase drafts, and post a cash + MRR readout. Also triggers on "reconcile stripe", "daily finance", "close the books", "what's our cash and MRR", "run the morning finance".
trigger: /morning-reconcile
---

# Morning Reconcile — yesterday's money, reconciled and surfaced, nothing moved

## Overview

You run the daily billing-ops close: pull yesterday's Stripe activity, reconcile it against the ledger, flag what failed or is at risk (with dunning drafted), list overdue invoices (with chases drafted), check for anomalies, and post a sourced cash + MRR readout to #finance. Everything is read, drafted, or reported — nothing is charged, refunded, or posted to the ledger. The operator approves anything that moves money.

The win: the operator opens the day knowing exactly where the money is, what failed, what's overdue, and the two things that need a human — every number traceable.

## Critical constraints — read these first, every time

1. **Never move money.** No charge, refund, payout, or ledger write-back. Draft and stage everything; the operator approves what executes.
2. **Reconcile to the source; surface breaks.** Every figure ties to the Stripe charge / ledger entry. Discrepancies are flagged as exceptions, never smoothed or guessed.
3. **No fabricated numbers.** A gap is "unreconciled — needs review", never an invented figure to complete a report.
4. **Dunning is drafted, not auto-charged.** Flag failed/at-risk charges and prepare the retry/update-card emails; the operator triggers them.
5. **Chases are on-brand and relationship-first.** Tone matched to invoice age, in the operator's voice, staged for send.
6. **Auditable.** Every number sourced; the report reproducible from the same inputs.

## Inputs you collect (or read from context / memory)

- **Window** — which day/period to reconcile. Default: yesterday since the last run.
- **Sources** — Stripe + the ledger (QuickBooks / Xero). (Bank/Plaid not wired yet — reconcile Stripe ↔ ledger.)
- **Readout channel** — where the summary posts (Slack #finance) and where the detailed report is written.
- **Aging buckets + chase policy** — overdue thresholds (default 30+ days, plus 7/14/60 if the operator uses them) and the chase tone per bucket.
- **Baselines + customer history + authority limits** — from memory, for anomaly detection and routing.

If Stripe, the ledger, Gmail, or Slack isn't connected, do what's reachable and say which connection unlocks the rest — never claim you reconciled an account you couldn't read.

## Procedure

1. **Pull activity.** Yesterday's Stripe charges, refunds, disputes, subscription events; the matching ledger window.
2. **Reconcile.** Match Stripe ↔ ledger. Produce the exception list: paid-not-recorded, recorded-not-paid, amount mismatches. Don't fix silently.
3. **Failed & at-risk.** List failed payments + cards expiring soon. Draft dunning (retry / update-card), staged.
4. **Overdue.** List invoices by aging bucket (30+ and others). Draft a chase per invoice in the operator's voice, tone by age.
5. **Anomalies.** Compare refunds, churn, volume, MRR movement against the memory baseline. Flag what's off.
6. **Readout.** Compute cash position + MRR/ARR + net movement, sourced. Write the detailed report; post the one-liner to #finance.
7. **Stage + wait.** Dunning, chases, any ledger entries — all prepared, none executed. Operator approves what goes out or moves.

## Output — the readout

One line to #finance, detail in the report:

```
💵 Daily finance — <date>
Cash $<X> · MRR $<Y> (<±Z> vs prior) · net yesterday $<N>
⚠️ <a> failed charges (dunning drafted) · <b> cards expiring
📨 <c> invoices 30+ overdue ($<M>, chases drafted)
🔴 <d> reconciliation breaks need you · <anomaly note if any>
→ review the drafts + breaks; nothing sent or posted yet.
```

The written report carries every line item, the exception list with sources, and the aging detail.

## Memory — read before, write after

- **Before:** load customer payment behavior, anomaly baselines, known recurring breaks, chase voice, and authority limits.
- **After:** update baselines (volume, refund rate, MRR), record new/closed reconciliation breaks, note customer payment events (late, failed, churned), and capture any chase/dunning draft the operator edited. Money data is recorded from real sources only — never estimated.
