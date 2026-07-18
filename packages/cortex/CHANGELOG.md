# @ownware/cortex

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
