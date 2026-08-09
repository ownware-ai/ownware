# ownware

## 0.5.0

### Minor Changes

- c9bb51a: Add strict pluggable gateway storage with zero-config SQLite, explicitly selected tenant-owned PostgreSQL, immutable cross-adapter migrations, and transactionally ordered durable message history.
- 40d7804: Add an experimental, owner-only ChatGPT subscription connection flow backed by
  the local Codex app-server. The Gateway now exposes redacted status, login,
  logout, quota, and exact model discovery; the client wraps the additive wire
  contract; and React ships a standalone connection component with explicit
  managed and direct route states. Codex protocol support now includes the proven
  0.147 minor while continuing to reject unproven 0.146 builds.
- 40d7804: Add the central Provider Hub with a validated Models.dev catalog, explicit
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
- Make run model selection deterministic across request, thread, install, and
  profile preferences. Explicit unavailable choices and every runtime-incompatible
  winner now fail before dispatch, while same-runtime profile-default fallback
  returns an optional typed receipt identifying the configured and effective models.
- Add versioned task packs with immutable package evidence, revisioned
  global/workspace/top-level-agent controls, lazy root-agent skill loading, typed
  catalog APIs, and matching SQLite/PostgreSQL storage. Spawned helpers retain
  their explicit profile and skill-grant boundaries.
- Add an explicit live `ownware provider verify` command that records content-free
  evidence for one exact provider/model route. Verification output excludes
  credentials, endpoints, prompts, responses, and raw errors, and Provider Hub now
  rejects evidence from a mismatched runtime adapter or wire protocol.

### Patch Changes

- 40d7804: Clarify Ownware's public package documentation and metadata around the runtime
  boundary: a portable profile becomes a self-hosted service with an owned
  execution loop, durable state, permission flow, storage, and one typed client
  contract. Provider and messaging integrations remain documented as supported
  routes and optional adapters rather than the product category.
- Updated dependencies [c9bb51a]
- Updated dependencies [40d7804]
- Updated dependencies [40d7804]
- Updated dependencies [40d7804]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @ownware/cortex@0.5.0
  - @ownware/loom@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [cfe469c]
- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
- Updated dependencies [98fa75d]
- Updated dependencies [98fa75d]
- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
  - @ownware/cortex@0.4.0
  - @ownware/loom@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @ownware/cortex@0.3.0
  - @ownware/loom@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [fafcbb4]
  - @ownware/cortex@0.2.0
  - @ownware/loom@0.2.0
