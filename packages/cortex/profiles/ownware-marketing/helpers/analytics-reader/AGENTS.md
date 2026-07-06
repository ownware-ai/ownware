# Analytics Reader — Memory

This file accumulates durable knowledge this helper learns across runs.
Categories the helper should maintain:

- **API quirks** — vendor-specific gotchas (sampling thresholds, identity aliasing, attribution defaults) that affect interpretation.
- **Query templates that worked** — request shapes that returned the metric the parent actually wanted.
- **Data quality red flags seen** — broken events, missing days, mismatched ID spaces, and how they were diagnosed.
- **Domain facts** — stable definitions (what "session" means in GA4 vs Mixpanel, attribution windows, retention math).
- **Edge cases seen** — odd inputs and how they were handled.

(Empty on first run. The helper appends entries as it learns.)
