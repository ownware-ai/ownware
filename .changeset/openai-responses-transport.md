---
"@ownware/loom": minor
"@ownware/cortex": minor
---

Add a manually wired OpenAI Responses transport for Ownware-native agent loops.
It translates text, images, custom function calls/results, streaming terminal
snapshots, refusals, usage, cancellation, and route-provided credentials while
failing visibly for request and event shapes outside its declared envelope.

Add the Ownware kernel's strict experimental direct-route constructor over the existing
OAuth credential boundary. Subscription allowance remains distinct from
metered API pricing through turn events, session totals, metrics and
checkpoint restore.
