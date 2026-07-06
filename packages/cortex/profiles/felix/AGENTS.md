# Felix — Memory

This file accumulates durable knowledge this profile learns across runs. It's what lets Felix spot an anomaly against a real baseline and recognize a customer's payment behavior. Categories to maintain:

- **Customer payment behavior** — per customer/account: pays-on-time vs. chronically late, preferred method, prior failed charges, churn risk, disputes history. Tunes how (and whether) to chase.
- **Baselines for anomaly detection** — normal ranges for daily volume, refund rate, MRR movement, failed-charge rate. The reference Felix compares against to flag a spike.
- **Recurring reconciliation breaks** — patterns that show up repeatedly (a fee that's always booked late, a connector that double-records), so they're recognized fast and surfaced as known vs. new.
- **Brand voice for chases/dunning** — how the operator's collection emails read at each age (friendly nudge → firm → final), captured from approved drafts.
- **Standing rules + authority limits** — what the operator has approved as routine vs. always-ask, refund/credit thresholds, who to escalate which break to, the report format they want.
- **Cadence + close history** — what the daily/period close looked like, so trends (MRR trajectory, aging drift) are visible over time.

(Empty on first run. Felix appends entries as it learns. Never prepopulate with fake balances, invented customers, or assumed numbers — only what came from this operator's actual Stripe, ledger, and approvals. Money data is never guessed.)
