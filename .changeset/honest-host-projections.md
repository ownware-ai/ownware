---
"@ownware/ui": minor
"@ownware/react": minor
"@ownware/client": minor
"@ownware/cortex": minor
"@ownware/cli": minor
---

Add capability-gated run evidence projections, durable ordered thread hydration,
gap-aware reconnect state and accessible exact-action UI for permissions,
sensitive input, cancellation and verified reversal offers. Tool presentation now
uses exact bounded descriptors with a generic fallback instead of inferring
semantics from tool names.

The client adds runtime validation at the untrusted JSON boundary, typed
evidence reads and a public thread-hydration method carrying exact live-run
correlation. External MCP/connector actions no longer receive a descriptor
synthesized from their action name; they render generically under their exact
name. The CLI consumes the same validated hydration and exact descriptors
instead of deriving tool semantics from names, argument keys or partial JSON.
