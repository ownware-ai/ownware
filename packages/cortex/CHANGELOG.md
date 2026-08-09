# @ownware/cortex

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
- Record authoritative provider usage as immutable facts with append-only,
  classification-separated costs and exact pricebook evidence. Add bounded Provider
  Hub usage reads, summaries, export, reconciliation, and matching client methods.
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
- Updated dependencies [40d7804]
- Updated dependencies [40d7804]
- Updated dependencies
  - @ownware/loom@0.5.0

## 0.4.0

### Minor Changes

- cfe469c: Accept DOCX and XLSX source uploads after verifying their ZIP-container
  framing, publish the expanded upload envelope as Ownware Gateway capability
  version 12 / contract revision 0.31.0, and expose the same closed media-type
  union through the client and OpenAPI contract.

  Upload acceptance remains narrower than document understanding: preparation
  continues to refuse these formats with `source_media_unsupported` until a
  bounded extractor is implemented.

- cfe469c: Add the two core (auto-loaded) builtin profiles to the bundled `profiles/`
  dir. `ownware` is the default assistant ("Ari", `openai:gpt-5.5`, scout/
  researcher/general helpers, 8 everyday skills). `ownware-code` is a
  full-stack coding agent with read/write/edit/search/shell tools, four helper
  subagents (explore, planner, verifier, general), and ten skills (plan, review,
  commit, create-pr, verify, debug-agent, security-review, simplify, stuck,
  init). `profiles/BUILTINS.json` now classifies it as core; the helper profiles
  live nested under the parent's `helpers/` folder per the manifest convention.
- 00d263f: Publish a bounded owner-only connection inventory with provider-neutral status,
  fixed recovery guidance, opaque Ownware identities, and an explicit
  separate-grant requirement.
- 98fa75d: Make the production WhatsApp Cloud API text flow restart-safe: durably own and
  deduplicate inbound WAMIDs before webhook acknowledgement, preserve customer
  thread bindings, fence Gateway runs, journal per-chunk outbound attempts,
  reconcile Meta delivery statuses, preserve unknown send outcomes without blind
  resend, and add explicit operator-controlled human handoff commands.
- 98fa75d: Bind delegated-created conversation threads to a digest of the verified
  delegate, workspace, profile, subject, purpose and channel context. Mismatched
  or unbound continuation now denies before mutation. The same binding protects
  run snapshots, event streams, permission decisions and cancellation, while
  delegated runs receive no legacy unscoped identity, profile memory, AGENTS.md
  fallback or memory-proposal tool.
- cfe469c: Add a manually wired OpenAI Responses transport for Ownware-native agent loops.
  It translates text, images, custom function calls/results, streaming terminal
  snapshots, refusals, usage, cancellation, and route-provided credentials while
  failing visibly for request and event shapes outside its declared envelope.

  Add the Ownware kernel's strict experimental direct-route constructor over the existing
  OAuth credential boundary. Subscription allowance remains distinct from
  metered API pricing through turn events, session totals, metrics and
  checkpoint restore.

- 00d263f: Add subject-bound delegated principals and an owner-granted, field- and row-scoped Data View query contract with bounded verified cell selection.
- cfe469c: Redact secret-shaped values out of tool-call arguments and results before any
  gateway store keeps a copy: a new `redact-event` seam runs at both durable
  write paths (`EventIngestor.ingest` for `agent_events`/SSE and
  `SessionRunner.accumulateEvent` for the `messages` table), with a second pass
  on reassembled streamed arguments at `tool.call.end`. The engine now
  sanitizes every tool result centrally before the model sees it, the cross-zone
  combination opt-in is fixed to actually take effect, the plaintext
  `GET /providers/:provider/key` endpoint now requires an audit sink and records
  every reveal, and the raw `/api/v1/debug/*` event routes are no longer
  registered unless `OWNWARE_ENABLE_DEBUG_ROUTES=1` is set.
- 00d263f: Bind protected source read and search subjects to verified delegated principals and remove subject selection from their request bodies.

### Patch Changes

- 00d263f: Protect short-lived connection continuation material in an encrypted,
  scope-bound vault; redact legacy metadata; verify terminal cleanup; and prevent
  late completion results from resurrecting revoked connections.
- Updated dependencies [00d263f]
- Updated dependencies [cfe469c]
- Updated dependencies [cfe469c]
  - @ownware/loom@0.4.0

## 0.3.0

### Minor Changes

- Channel connect procedures: a durable, restart-safe engine for connecting
  messaging channels, driven from chat. `connect_channel` (contributed to every
  profile when channel procedures are enabled) starts or resumes a coded
  per-channel procedure that verifies stored credentials with the provider,
  pauses on the existing permission mechanic for the owner's consent (decline
  leaves state unchanged; abandonment leaves the gate waiting — a timeout is
  never a decision), registers the provider webhook, streams work lines, and
  records permanent append-only receipts. Ships the BYO WhatsApp Cloud API
  procedure (live credential probes, two-step callback registration,
  coexistence honesty, transient-vs-permanent Meta error handling). Connecting
  never makes an agent live — publishing stays a separate decision. The client
  SDK additionally surfaces `tool.call.progress` stream events as a new
  additive `progress` member on `RunStreamEvent`, so long procedures narrate
  instead of going silent.
- Add scoped, restart-safe source inspection jobs and compare-and-set source
  refreshes that invalidate inherited readiness and report safe conflict truth.
  Stale refresh placement is removed before conflict confirmation, with explicit
  cleanup-failed truth when absence cannot be verified.
  Add separately authorized bounded text preparation, versioned source-job
  projections, and content-free derived-resource manifests with explicit freshness.
  Advertise effective workspace/profile source quota ceilings, account for reserved
  growth transactionally, and return detail-minimised typed quota conflicts without
  blocking reads or non-growing recovery.
  Add separately authorized source deletion jobs with exact-revision fencing,
  durable replay, pre-destruction cancellation, partial retry, closed progress
  counts, and verified deletion before a minimal tombstone is reported.
  Add a provider-neutral internal access-grant foundation with immutable scoped
  revisions, live expiry/revocation, deny-by-default evaluation and hard floors
  that no permission or autonomy mode can bypass.
  Publish owner-only grant creation, inspection, pagination and exact-revision
  revocation, with durable minimal receipts. Add separately authorized delegated
  UTF-8 source-content ranges whose live grant and current source lineage are
  re-evaluated around the private read, plus SDK, capability and wire-contract
  support for the complete flow.
  Add a separately authorized `source_content.search` flow over one current
  prepared UTF-8 resource. The bounded literal scanner verifies the whole immutable
  object, re-evaluates grants and source truth before releasing results, returns
  stable byte-addressed evidence, and exposes explicit no-match, truncation, and
  no-partial timeout truth without a model or durable index.
- Webhook channels get an HTTP host: `ChannelWebhookHost` mounts stored
  WhatsApp/SMS channels at per-channel paths (`/webhooks/whatsapp/<id>`,
  `/webhooks/sms/<id>`), handles the Meta GET verification handshake, verifies
  provider signatures on the raw body before anything else, answers 200 fast and
  drives the agent asynchronously, dedups re-delivered provider message ids, and
  drops payloads addressed to a different phone_number_id. `ownware serve` and
  `ownware-channel start` start it automatically when an enabled webhook channel
  exists (loopback bind by default — put a tunnel or reverse proxy in front;
  `OWNWARE_WEBHOOK_PORT`/`OWNWARE_WEBHOOK_HOST`/`OWNWARE_WEBHOOK_PUBLIC_URL`).
  Previously the WhatsApp/SMS adapters were library-only: nothing mounted them.

### Patch Changes

- @ownware/loom@0.3.0

## 0.2.0

### Minor Changes

- fafcbb4: Gateway scope-to-core (part 1): leaner, honest public surface.

  - `POST /api/v1/profiles` no longer requires `productId` — create an agent with just
    `{ name }`. An explicit `productId` is still validated (unknown → 400, closed → 403);
    when absent it defaults to the open `ownware` product.
  - Removed legacy desktop-client endpoints that are not part of the platform contract:
    `GET /api/v1/session/state`, `POST /api/v1/session/restore` (desktop crash-restore),
    `POST/GET /api/v1/threads/:threadId/edit-target`, `GET /api/v1/profiles/:slug/edits`
    (desktop builder thread-binding). The related `SessionState` / `PersistedSessionState` /
    `SessionWorkspace` type exports were removed.
  - Removed the drifted `RunRequestSchema` / `ResumeRequestSchema` exports — they no longer
    matched the live handlers. The run/resume wire contract is documented in
    `@ownware/client`'s `spec/openapi.yaml`; the run handler's own strict schema is the
    single validation source.
  - Removed more legacy desktop-only surface: `POST /api/v1/onboarding/{role,complete}`
    (first-run wizard; nothing read what it wrote), `POST /api/v1/connectors/sniff`
    (paste-anything classifier), and `GET /api/v1/detected-apps` (machine-local app scan)
    with its unused detection helpers. The `OnboardingRoleSchema` / `OnboardingCompleteSchema`
    exports were removed. The known-apps catalog and the `runtime_setup` connector auth
    mode (including `POST /api/v1/connectors/:id/runtime-setup`) are unaffected.
  - Removed the legacy desktop design-canvas HTTP surface: every `/api/v1/designs/*`
    endpoint, `/api/v1/workspaces/:wsId/designs`, `/api/v1/threads/:threadId/design`,
    the `/api/v1/fonts/{css,file}` proxy, `/api/v1/profiles/:profileId/design-systems*`,
    and the per-design fs-events SSE channel, along with their handlers, the design
    fs-watcher service, and the `Design` wire type. `activeContext` on `POST /api/v1/run`
    now carries only `skills` — the canvas-only `designSystems`/`selection` inputs were
    removed (vertical context still ships via the generic `systemPromptAppend`
    passthrough). The bundled design agent profile and its tools are unaffected. The
    `designs`/`thread_designs` tables remain until a later cleanup migration.
  - Removed the legacy desktop shell's workspace chrome: the pane substrate
    (`/workspaces/:id/panes*`, `/layout`, pane SSE, the `open_pane` tool and its exports),
    the desktop terminal-panel HTTP surface (`/workspaces/:id/terminal*` — the per-workspace
    agent PTY registry that `shell_execute` persists into is unchanged), the files-panel
    surface (`/workspaces/:id/files*` and the git/diff/watch service), the workspace
    build-board endpoints (`/boards/*`, `/workspaces/:id/boards*` and the `board_write`/
    `board_update` session tools — Agent Teams' board is separate and unaffected), and the
    desktop-only workspace extras (`/workspaces/browse`, `/:id/history`, `/:id/files`).
    Workspaces themselves (project-folder CRUD — the filesystem root for HTTP runs) remain
    a supported platform surface.
  - Removed the legacy product catalog: `GET /api/v1/products`, the manifest and its
    exports, and every product gate. `productId` on agent.json and `surface` on teams are
    now accepted, inert kebab-slugs (existing profiles keep loading unchanged); profile
    create/duplicate no longer consult a catalog, and malformed profile fields now answer
    400 instead of 500. Migration 049 drops the legacy desktop tables whose code paths
    were removed (`designs`, `thread_designs`, `thread_edits`, `boards`, `board_slices`,
    `board_findings`) — desktop-UI state only; threads and messages are untouched.
  - Removed the orphaned pane data layer (workspace-pane state/db methods, Pane wire
    types and Zod schemas, workspace-history types). `Workspace.tabCount` is kept on the
    wire as a constant 0 for shape stability. Migration 050 drops `workspace_panes`
    (desktop tab/pane layout state only).

### Patch Changes

- @ownware/loom@0.2.0
