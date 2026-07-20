---
"@ownware/shuttle": minor
"@ownware/cortex": minor
---

Make the production WhatsApp Cloud API text flow restart-safe: durably own and
deduplicate inbound WAMIDs before webhook acknowledgement, preserve customer
thread bindings, fence Gateway runs, journal per-chunk outbound attempts,
reconcile Meta delivery statuses, preserve unknown send outcomes without blind
resend, and add explicit operator-controlled human handoff commands.
