---
"@ownware/loom": minor
"@ownware/cortex": minor
"@ownware/client": minor
"@ownware/cli": minor
"@ownware/react": minor
"ownware": minor
---

Add the central Provider Hub with a validated Models.dev catalog, explicit
route and verification truth, nine resolver-backed OpenAI-compatible provider
presets, and managed custom compatible endpoints for local or cloud inference.
Custom keys remain in Ownware's encrypted credential store, while the typed
client and OpenAPI contract expose only secret-free configuration and catalog
state. Provider Hub is also the single model-discovery and pricebook authority:
the React and CLI pickers consume it directly, ambient API-key and local Ollama
connections join the same view, and the deprecated `/api/v1/models` route is
only a compatibility projection of that assembled generation. Automatic
fallback additionally checks the live runtime adapter registry, while normal
model listing consumes only already-observed Codex state and never starts the
optional subscription runtime.
