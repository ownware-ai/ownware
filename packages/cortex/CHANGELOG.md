# @ownware/cortex

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
