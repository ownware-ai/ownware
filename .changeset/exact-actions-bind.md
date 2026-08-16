---
"@ownware/loom": minor
"@ownware/cortex": minor
"@ownware/client": minor
"ownware": minor
---

Bind explicit permission decisions to one immutable run, request, agent, tool,
input and policy/tool revision; consume each approval once at the final supported
dispatch boundary; and atomically claim held schedule effects. Interrupted
schedule claims now recover as indeterminate instead of being retried, while
remote target freshness is claimed only for tools with an authority-backed
conditional-effect contract.
