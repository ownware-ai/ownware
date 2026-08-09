# @ownware/react

## 0.2.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [40d7804]
- Updated dependencies [40d7804]
- Updated dependencies [40d7804]
- Updated dependencies
- Updated dependencies
  - @ownware/client@0.5.0

## 0.1.3

### Patch Changes

- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
- Updated dependencies [98fa75d]
- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
  - @ownware/client@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ownware/client@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @ownware/client@0.2.0
