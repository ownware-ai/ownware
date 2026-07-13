/**
 * Cortex Database Schema
 *
 * Production-grade SQLite schema for the Cortex gateway.
 * Stores threads, messages, usage records.
 *
 * Design principles:
 * - Every table has created_at/updated_at
 * - Indexes on all query patterns the gateway uses
 * - Messages stored as JSON for tool calls, subagents, etc.
 * - Cascade deletes: thread deletion removes messages + usage
 * - Migration system for schema evolution
 */

// ---------------------------------------------------------------------------
// Migrations (applied in order, never modified once deployed)
// ---------------------------------------------------------------------------

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
  /**
   * Set ONLY when this migration intentionally contains destructive SQL
   * (DROP TABLE / DROP COLUMN / DELETE FROM / RENAME) and the author has
   * verified it cannot lose real user data — e.g. a 12-step table rebuild
   * that copies rows forward first, or cleanup of system-seeded rows. The
   * required `reason` documents WHY it is safe.
   *
   * New migrations (version > DESTRUCTIVE_AUDIT_BASELINE) that contain
   * destructive SQL without this field fail `auditMigrations` — see
   * migration-safety.ts and MIGRATION-POLICY.md (R4, §4 expand→contract).
   */
  readonly destructive?: { readonly reason: string }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001_threads_messages',
    sql: `
      -- Threads (conversations)
      CREATE TABLE IF NOT EXISTS threads (
        id              TEXT        PRIMARY KEY,
        profile_id      TEXT        NOT NULL,
        title           TEXT,
        status          TEXT        NOT NULL DEFAULT 'active',
        message_count   INTEGER     NOT NULL DEFAULT 0,
        total_tokens    INTEGER     NOT NULL DEFAULT 0,
        total_cost      REAL        NOT NULL DEFAULT 0,
        model           TEXT,
        pinned          INTEGER     NOT NULL DEFAULT 0,
        metadata        TEXT,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_threads_profile
        ON threads(profile_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_status
        ON threads(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_updated
        ON threads(updated_at DESC);

      -- Messages (individual messages within threads)
      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT        PRIMARY KEY,
        thread_id       TEXT        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role            TEXT        NOT NULL,
        content         TEXT        NOT NULL DEFAULT '',
        tools           TEXT,
        sub_agents      TEXT,
        permissions     TEXT,
        attachments     TEXT,
        thinking        TEXT,
        usage_input     INTEGER,
        usage_output    INTEGER,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread
        ON messages(thread_id, created_at ASC);

      -- Usage records (per-request token tracking)
      CREATE TABLE IF NOT EXISTS usage_records (
        id              TEXT        PRIMARY KEY,
        thread_id       TEXT        REFERENCES threads(id) ON DELETE SET NULL,
        profile_id      TEXT        NOT NULL,
        model           TEXT        NOT NULL,
        provider        TEXT        NOT NULL,
        input_tokens    INTEGER     NOT NULL DEFAULT 0,
        output_tokens   INTEGER     NOT NULL DEFAULT 0,
        total_tokens    INTEGER     NOT NULL DEFAULT 0,
        cost_usd        REAL        NOT NULL DEFAULT 0,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_usage_profile
        ON usage_records(profile_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_thread
        ON usage_records(thread_id);

      -- Migration tracking
      CREATE TABLE IF NOT EXISTS _migrations (
        version     INTEGER     PRIMARY KEY,
        name        TEXT        NOT NULL,
        applied_at  TEXT        NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    name: '002_workspaces_mcp',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Workspaces (project folders — like tmux sessions)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS workspaces (
        id              TEXT        PRIMARY KEY,
        name            TEXT        NOT NULL,
        path            TEXT        NOT NULL UNIQUE,
        status          TEXT        NOT NULL DEFAULT 'active',
        last_profile_id TEXT,
        pinned          INTEGER     NOT NULL DEFAULT 0,
        metadata        TEXT,
        last_opened_at  TEXT        NOT NULL DEFAULT (datetime('now')),
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_path
        ON workspaces(path);
      CREATE INDEX IF NOT EXISTS idx_workspaces_opened
        ON workspaces(last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspaces_pinned
        ON workspaces(pinned DESC, last_opened_at DESC);

      -- Which profiles have been used in each workspace
      CREATE TABLE IF NOT EXISTS workspace_profiles (
        workspace_id    TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        profile_id      TEXT        NOT NULL,
        thread_count    INTEGER     NOT NULL DEFAULT 0,
        last_used_at    TEXT        NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, profile_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_profiles_ws
        ON workspace_profiles(workspace_id);

      -- ────────────────────────────────────────────────────────────
      -- MCP Servers (global server definitions)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id              TEXT        PRIMARY KEY,
        name            TEXT        NOT NULL,
        transport       TEXT        NOT NULL,
        url             TEXT,
        command         TEXT,
        args            TEXT,
        headers         TEXT,
        registry_id     TEXT,
        tool_count      INTEGER,
        status          TEXT        NOT NULL DEFAULT 'configured',
        error           TEXT,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- Which profiles use which MCP servers
      CREATE TABLE IF NOT EXISTS profile_mcp_servers (
        profile_id      TEXT        NOT NULL,
        server_id       TEXT        NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        added_at        TEXT        NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (profile_id, server_id)
      );

      CREATE INDEX IF NOT EXISTS idx_profile_mcp_profile
        ON profile_mcp_servers(profile_id);
      CREATE INDEX IF NOT EXISTS idx_profile_mcp_server
        ON profile_mcp_servers(server_id);

      -- ────────────────────────────────────────────────────────────
      -- Add workspace_id to threads (nullable for backwards compat)
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE threads ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
    `,
  },
  {
    version: 3,
    name: '003_threads_workspace_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_threads_workspace
        ON threads(workspace_id, updated_at DESC);
    `,
  },
  {
    version: 4,
    name: '004_studio_foundation',

    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Local profile (onboarding display name — NOT login/auth)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS local_profile (
        id              TEXT        PRIMARY KEY,
        display_name    TEXT        NOT NULL,
        avatar_url      TEXT,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- ────────────────────────────────────────────────────────────
      -- User settings (theme, font size, etc.)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS user_settings (
        id              TEXT        PRIMARY KEY,
        key             TEXT        NOT NULL UNIQUE,
        value           TEXT        NOT NULL,
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- ────────────────────────────────────────────────────────────
      -- Profile metadata (icon, color, category for the client UI)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS profile_metadata (
        profile_id      TEXT        PRIMARY KEY,
        icon            TEXT,
        color           TEXT,
        category        TEXT,
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- ────────────────────────────────────────────────────────────
      -- Workspace tabs (open tabs per workspace)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS workspace_tabs (
        id              TEXT        PRIMARY KEY,
        workspace_id    TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        thread_id       TEXT        REFERENCES threads(id) ON DELETE SET NULL,
        label           TEXT        NOT NULL,
        kind            TEXT        NOT NULL DEFAULT 'thread',
        position        INTEGER     NOT NULL DEFAULT 0,
        active          INTEGER     NOT NULL DEFAULT 0,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- ────────────────────────────────────────────────────────────
      -- App-level key/value state
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS app_state (
        key             TEXT        PRIMARY KEY,
        value           TEXT        NOT NULL,
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- ────────────────────────────────────────────────────────────
      -- Audit log (security persistence)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS audit_log (
        id              TEXT        PRIMARY KEY,
        action          TEXT        NOT NULL,
        entity_type     TEXT        NOT NULL,
        entity_id       TEXT,
        detail          TEXT,
        ip_address      TEXT,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- ────────────────────────────────────────────────────────────
      -- ALTER existing tables
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE usage_records ADD COLUMN duration_ms INTEGER;
      ALTER TABLE usage_records ADD COLUMN success INTEGER DEFAULT 1;
      ALTER TABLE threads ADD COLUMN last_message_preview TEXT;

      -- ────────────────────────────────────────────────────────────
      -- New indexes
      -- ────────────────────────────────────────────────────────────
      CREATE INDEX IF NOT EXISTS idx_usage_date
        ON usage_records(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_profile_date
        ON usage_records(profile_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_name
        ON mcp_servers(name);
      CREATE INDEX IF NOT EXISTS idx_profile_meta_category
        ON profile_metadata(category);
      CREATE INDEX IF NOT EXISTS idx_workspace_tabs_ws
        ON workspace_tabs(workspace_id, position ASC);
    `,
  },
  {
    version: 5,
    name: '005_profile_metadata_usage',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Add usage tracking columns to profile_metadata
      -- Allows incrementProfileUsage() to track per-profile stats
      -- without hitting usage_records every time.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE profile_metadata ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE profile_metadata ADD COLUMN total_cost REAL NOT NULL DEFAULT 0;
      ALTER TABLE profile_metadata ADD COLUMN last_used_at TEXT;
    `,
  },
  {
    version: 6,
    name: '006_agent_events',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent events — append-only event log keyed by (thread, agent).
      --
      -- One table for BOTH parent and subagent events, distinguished by
      -- agent_id. Parent agent uses agent_id='root', subagents use their
      -- spawner-assigned id (e.g. 'agent_a3f7c2b1'). parent_agent_id
      -- points up the tree so nested subagents work recursively.
      --
      -- SSE handlers replay rows from here, then tail the in-memory
      -- EventBus for live events. Write-then-publish ordering guarantees
      -- "live is always a suffix of disk" — no dropped events, no gaps.
      --
      -- seq is monotonic per (thread_id, agent_id), assigned by the
      -- ingestor. It's the cursor clients use to resume after reconnect.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS agent_events (
        thread_id       TEXT    NOT NULL,
        agent_id        TEXT    NOT NULL,
        parent_agent_id TEXT,
        seq             INTEGER NOT NULL,
        type            TEXT    NOT NULL,
        payload         TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (thread_id, agent_id, seq)
      );

      -- Replay query: WHERE thread_id=? AND agent_id=? AND seq>? ORDER BY seq.
      -- The PK already covers this perfectly — no extra index needed for the
      -- per-(thread, agent) tail. An additional index on (thread_id, seq)
      -- lets us list "all events on this thread" across all agents if we
      -- ever need a cross-agent timeline view.
      CREATE INDEX IF NOT EXISTS idx_agent_events_thread
        ON agent_events(thread_id, seq);

      -- Nested subagent lookup: "show me every child of this agent".
      CREATE INDEX IF NOT EXISTS idx_agent_events_parent
        ON agent_events(thread_id, parent_agent_id, seq)
        WHERE parent_agent_id IS NOT NULL;
    `,
  },
  {
    version: 7,
    name: '007_workspace_tabs_invariants',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Tab/thread split hygiene.
      --
      -- The workspace_tabs table existed since v4 but the client was
      -- driving the tab bar off threads directly, so close-tab was
      -- hard-deleting threads. The backend now treats tabs as the
      -- view state over threads (persistent history). This migration
      -- lays down the invariants the runtime depends on:
      --
      --  1. A workspace can have at most ONE tab per thread. Reopen
      --     from history activates the existing tab instead of
      --     creating a second one.
      --  2. Only one tab in a workspace can be active at a time.
      --     Enforced as a partial unique index so we can have zero
      --     active (empty workspace) but never two.
      --  3. Dangling thread-kind tabs whose thread_id was nulled by
      --     the v4 'ON DELETE SET NULL' clause are meaningless —
      --     drop them so the UI never renders a ghost tab.
      -- ────────────────────────────────────────────────────────────

      -- Repair any rows left behind by the old cascade rule.
      DELETE FROM workspace_tabs
      WHERE kind = 'thread' AND thread_id IS NULL;

      -- Partial unique indexes (SQLite honours the WHERE clause).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_tabs_thread_unique
        ON workspace_tabs(workspace_id, thread_id)
        WHERE thread_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_tabs_one_active
        ON workspace_tabs(workspace_id)
        WHERE active = 1;
    `,
  },
  {
    version: 8,
    name: '008_connector_connections_and_composio_catalog',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- connector_connections — per-connection OAuth/API-key state.
      --
      -- Phase 2a (Connector Foundation): durable source of truth for
      -- "user has connected (or is connecting to) connector X with
      -- source Y as entity Z". Source-agnostic by construction:
      --
      --   - Composio (Phase 2b) writes rows here keyed by connection_id.
      --   - Webhook-driven MCP connectors (later) write here when the
      --     subscription handshake completes.
      --   - Pipedream / Zapier / custom OAuth (later) all use the same
      --     state machine: pending → ready | failed | expired.
      --
      -- Uniqueness: exactly ONE live row (pending or ready) per
      -- (connector_id, source, entity_id). Terminal rows (failed,
      -- expired) are retained for audit without blocking retries —
      -- hence the partial unique index rather than a plain UNIQUE.
      --
      -- Timestamps are unix MILLISECONDS (INTEGER). This is intentionally
      -- different from threads.created_at (ISO TEXT) — the connections
      -- table is operational, not user-facing, and the poller does
      -- Date.now() arithmetic on expires_at constantly; keeping numeric
      -- avoids ISO-parse in the hot path.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS connector_connections (
        connection_id   TEXT        PRIMARY KEY,
        connector_id    TEXT        NOT NULL,
        source          TEXT        NOT NULL,
        entity_id       TEXT,
        status          TEXT        NOT NULL,
        initiated_at    INTEGER     NOT NULL,
        completed_at    INTEGER,
        last_polled_at  INTEGER,
        expires_at      INTEGER,
        error_reason    TEXT,
        metadata_json   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_connector_connections_lookup
        ON connector_connections(connector_id, source, entity_id);
      CREATE INDEX IF NOT EXISTS idx_connector_connections_status
        ON connector_connections(status, expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_connections_one_live
        ON connector_connections(connector_id, source, entity_id)
        WHERE status IN ('pending','ready');

      -- ────────────────────────────────────────────────────────────
      -- composio_catalog — cached vendor catalogue.
      --
      -- Per-vendor tables (composio_catalog, pipedream_catalog in M4,
      -- etc.) keep vendor-specific fields honest instead of bloating
      -- one generic table with NULLs. A generic store interface wraps
      -- the concrete table so the rest of the kernel reads uniformly.
      --
      -- Phase 2a ships the empty table + store. Phase 2b's HTTP
      -- client populates it.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS composio_catalog (
        app_id                 TEXT        PRIMARY KEY,
        name                   TEXT        NOT NULL,
        slug                   TEXT        NOT NULL,
        category               TEXT,
        icon_url               TEXT,
        description            TEXT,
        auth_mode              TEXT        NOT NULL,
        scopes_json            TEXT,
        action_manifest_digest TEXT,
        last_synced_at         INTEGER     NOT NULL,
        deleted_at             INTEGER,
        raw_json               TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_composio_catalog_slug
        ON composio_catalog(slug);
      CREATE INDEX IF NOT EXISTS idx_composio_catalog_category
        ON composio_catalog(category)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 9,
    name: '009_connector_connections_auth_config_id',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Phase 2b.1 (Composio Connect Layer): record which Composio
      -- auth_config_id was used when the link was created.
      --
      -- Nullable because (a) existing 2a rows predate this column and
      -- (b) non-Composio sources (webhook MCP, future OAuth) don't have
      -- an auth_config_id concept.
      --
      -- Carried on the row (not just metadata_json) so the listener
      -- can be called without re-parsing JSON, and so a future admin
      -- UI can filter by auth_config_id cheaply.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE connector_connections ADD COLUMN auth_config_id TEXT;
    `,
  },
  {
    version: 10,
    name: '010_composio_catalog_has_managed_auth_config',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Phase 2b.2b (Admin-setup UX): record whether the toolkit
      -- has a Composio-managed auth_config in the current org.
      --
      -- Nullable so existing rows (pre-v10) and sync failures
      -- transparently read as "unknown" — the client treats unknown as
      -- "probably connectable, fall back to click-time error UX".
      -- Sync populates this via a single paginated /auth_configs
      -- walk with isComposioManaged=true.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE composio_catalog ADD COLUMN has_managed_auth_config INTEGER;
    `,
  },
  {
    version: 11,
    name: '011_agent_events_retention_index',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Retention index for agent_events pruning.
      --
      -- The retention job deletes rows where (thread_id belongs to a
      -- terminal thread) AND (created_at < cutoff). Without an index
      -- on created_at the scan is O(N) over every event ever written.
      -- The compound (thread_id, created_at) index lets the planner
      -- push the thread filter down and scan only the tail per-thread.
      --
      -- The existing PK (thread_id, agent_id, seq) doesn't help here —
      -- retention cares about wall-clock age, not seq order.
      -- ────────────────────────────────────────────────────────────
      CREATE INDEX IF NOT EXISTS idx_agent_events_created
        ON agent_events(thread_id, created_at);
    `,
  },
  {
    version: 12,
    name: '012_messages_parts',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Ordered turn timeline for hydrated messages.
      --
      -- Before this column the reducer flattened a turn into separate
      -- tools[]/subAgents[]/permissions[] arrays plus one concatenated
      -- text string, destroying the order in which segments were
      -- streamed. parts is a JSON array of discriminated entries —
      -- text/thinking inline, tool/subagent/permission referenced by
      -- stable id — that preserves the original ordering for hydrated
      -- transcripts.
      --
      -- Nullable because (a) every row written before this migration
      -- has no parts column to migrate from and (b) some role values
      -- (system, error, user) don't need a timeline. Clients that see
      -- parts=null fall back to the legacy "text + trailing tools"
      -- layout — same behaviour as today.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE messages ADD COLUMN parts TEXT;
    `,
  },
  {
    version: 13,
    name: '013_messages_credentials',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Credential HITL records per assistant turn.
      --
      -- Before this column, credential.request / credential.response
      -- events were fanned out to live SSE consumers but never folded
      -- into the messages row. A page refresh during or after a
      -- credential exchange therefore had no row data to rebuild the
      -- CredentialChatItem from, and the UI fell back to just the
      -- underlying request_credential tool card — no input field,
      -- no "stored / denied" receipt.
      --
      -- This column stores a JSON array of CredentialRecord objects
      -- (see packages/cortex/src/gateway/types.ts) in the same spirit
      -- as permissions: one entry per request the turn emitted, with
      -- metadata, decision, and an optional credentialId vault
      -- pointer. The secret value is NEVER stored here — that lives
      -- only in the credentials runtime vault, addressed by id.
      --
      -- Nullable so every pre-migration row loads cleanly as
      -- credentials: undefined. Matches the permissions /
      -- sub_agents / parts pattern.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE messages ADD COLUMN credentials TEXT;
    `,
  },
  {
    version: 14,
    name: '014_tasks',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Task list — "the agent's TODO list" surfaced in the Tasks
      -- panel (client workspace-panels board, T01-T04).
      --
      -- One row per task. Scoped by thread_id so each conversation
      -- gets its own list; cascade-delete with the thread mirrors
      -- the same lifecycle rule used by messages + permissions.
      --
      -- \`list_order\` is a 0-indexed position within the thread.
      -- The \`todo_write\` tool (Loom) passes the FULL ordered list on
      -- every call; the store implementation replaces rows in a
      -- single transaction so list_order always reflects the caller's
      -- intent, never an insertion artifact.
      --
      -- Status values are validated in TypeScript before insert
      -- ('pending' | 'in_progress' | 'completed') — same
      -- enforcement-at-the-app-layer pattern used for
      -- \`messages.role\`.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT    PRIMARY KEY,
        thread_id   TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        content     TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        list_order  INTEGER NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_thread
        ON tasks(thread_id, list_order ASC);
    `,
  },
  {
    version: 15,
    name: '015_credentials',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Unified credentials table.
      --
      -- Single home for every credential the gateway holds — LLM
      -- provider keys, MCP server credentials, Composio OAuth grants,
      -- bearer/basic-auth secrets for tools.
      --
      -- Encryption: AES-256-GCM with the master key from
      -- \`~/.ownware/.master-key\` (the same key the file vault used).
      -- Encrypted value lives in \`encrypted_value\` as the v2 vault
      -- string format \"v2:<ivHex>:<authTagHex>:<cipherHex>\" so the
      -- existing \`encryptV2\` / \`decrypt\` helpers in vault.ts can be
      -- used unchanged, and so a future migration off the master key
      -- only touches the encrypt/decrypt helpers, not the schema.
      --
      -- Plaintext value NEVER lives in any other column.
      -- \`hint\` is the masked tail (\"...XXXX\") used in every list
      -- view; \`granted_scopes\`, \`spend_cap\`, and \`tags\` are JSON
      -- payloads parsed at the SQLite boundary.
      --
      -- Timestamps are app-supplied ISO 8601 (toISOString) so they
      -- pass the \`Credential\` Zod schema (\`datetime({ offset: true })\`).
      -- DEFAULT (datetime('now')) is omitted on purpose — every insert
      -- carries an explicit \`created_at\` / \`updated_at\` from JS.
      --
      -- Indexes match the read paths the unified API exposes:
      --   - filter by category (Settings tabs)
      --   - filter by for_connector (per-connector group view)
      --   - filter by status (resolver fast-fail; admin views)
      --   - sort by created_at (deterministic list order)
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS credentials (
        id              TEXT    PRIMARY KEY,
        name            TEXT    NOT NULL,
        variable_name   TEXT,
        category        TEXT    NOT NULL,
        for_connector   TEXT,
        auth_type       TEXT    NOT NULL,
        encrypted_value TEXT    NOT NULL,
        hint            TEXT    NOT NULL,
        granted_scopes  TEXT,
        trust           TEXT    NOT NULL DEFAULT 'medium',
        spend_cap       TEXT,
        source          TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'ready',
        status_reason   TEXT,
        expires_at      TEXT,
        last_used_at    TEXT,
        tags            TEXT,
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_credentials_category
        ON credentials(category);
      CREATE INDEX IF NOT EXISTS idx_credentials_for_connector
        ON credentials(for_connector)
        WHERE for_connector IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_credentials_status
        ON credentials(status);
      CREATE INDEX IF NOT EXISTS idx_credentials_created
        ON credentials(created_at);
    `,
  },
  {
    version: 16,
    name: '016_credential_audit_log',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Credential audit log (board: credentials-unification — C28).
      --
      -- One row per security-relevant credential event:
      --
      --   - 'resolve'  → gateway resolver injected the credential at an
      --                  OS boundary. Carries cost (if LLM) + outcome.
      --   - 'reveal'   → renderer requested the plaintext via
      --                  POST /credentials/:id/reveal.
      --   - 'validate' → POST /credentials/:id/validate ran a real
      --                  provider call.
      --   - 'create' / 'update' / 'delete' → DB mutations to the
      --                  credentials table.
      --   - 'approval_granted' / 'approval_denied' → trust-gate
      --                  outcomes for trust:high resolves (C30).
      --
      -- Append-only, never updated. The retention layer can compact
      -- rows older than 30d into per-credential aggregates (C29 reads
      -- the same table for spend rollups; aggregates would speed up
      -- those queries at the cost of losing per-event detail).
      --
      -- Why a separate table from the existing \`audit_log\`:
      --   - Schema is wider (agent_id, session_id, tool_name, costs).
      --   - Foreign key to credentials enables ON DELETE CASCADE for
      --     hard-deletes (soft-delete keeps the audit row).
      --   - Indexed for the per-credential timeline query the UI runs.
      --
      -- The plaintext value is NEVER in this table. The 'detail' JSON
      -- column may carry context (host hit, scopes returned, error
      -- reason) but the value itself is structurally absent.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS credential_audit_log (
        id                  TEXT    PRIMARY KEY,
        credential_id       TEXT    NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        event_type          TEXT    NOT NULL,
        outcome             TEXT    NOT NULL,
        agent_id            TEXT,
        session_id          TEXT,
        thread_id           TEXT,
        tool_name           TEXT,
        host                TEXT,
        detail              TEXT,
        estimated_cost_usd  REAL,
        actual_cost_usd     REAL,
        created_at          TEXT    NOT NULL
      );

      -- Per-credential timeline view ("what happened to my Stripe key
      -- in the last hour"). Most common query the audit UI fires.
      CREATE INDEX IF NOT EXISTS idx_credential_audit_credential
        ON credential_audit_log(credential_id, created_at DESC);

      -- Cross-credential time range view (admin / "all activity in last 24h").
      CREATE INDEX IF NOT EXISTS idx_credential_audit_created
        ON credential_audit_log(created_at DESC);

      -- Per-credential per-event-type view (e.g. "all reveals of this row").
      CREATE INDEX IF NOT EXISTS idx_credential_audit_event
        ON credential_audit_log(credential_id, event_type, created_at DESC);
    `,
  },
  {
    version: 17,
    name: '017_mcp_tools_metadata',
    sql: `
      -- Store per-tool metadata discovered during MCP connect handshake.
      -- JSON array of { name, description, inputSchema, annotations }.
      -- Populated by POST /mcp/connect/:serverId when tools/list succeeds.
      -- Read by the connector registry to populate Connector.actions[].
      ALTER TABLE mcp_servers ADD COLUMN tools_json TEXT;
    `,
  },
  {
    version: 18,
    name: '018_memory_system',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Memory system — replaces the static AGENTS.md notebook with
      -- a DB-backed learning loop:
      --
      --   agent calls remember(text)  →  memory_proposals (pending)
      --                                  ↓ user accepts via UI
      --                                  memories (active)
      --                                  ↓ next session assembled
      --                                  top-N ranked rows render into
      --                                  the system prompt
      --
      -- Tables:
      --   memories          Per-profile durable facts the agent should
      --                     recall across threads. Ranked at read time.
      --   memory_proposals  Approval queue. Agent's remember() tool
      --                     writes here; users accept/reject/edit.
      --   user_identity     Single-row global identity (name, role,
      --                     timezone, …). Auto-prepended to every
      --                     profile's system prompt.
      --
      -- Profile portability: AGENTS.md remains a one-way export view
      -- regenerated from memories on profile export. Memory data lives
      -- in ownware.db, NOT in the profile folder, so sharing a profile
      -- never leaks the user's private accumulated memories.
      -- ────────────────────────────────────────────────────────────

      -- ── memories ─────────────────────────────────────────────────
      -- One row per accepted memory.
      --
      -- scope:        Reserved for future per-workspace partitioning.
      --               Always 'agent' in v1 (per-profile). Carrying the
      --               column from day one means workspace scope can
      --               ship later without a migration.
      -- kind:         'fact' | 'preference' | 'correction' | 'identity'.
      --               UI hint and ranking signal — preferences and
      --               identity bias higher in tie-breaks.
      -- source:       'user_pinned' | 'agent_proposed' | 'reflection' |
      --               'legacy_import'. Provenance for audit / UI.
      -- confidence:   0.0–1.0. user_pinned defaults 1.0;
      --               agent_proposed defaults 0.8 (boosted on user
      --               accept). Used as a ranking tiebreak.
      -- status:       'active' | 'superseded' | 'archived'.
      --               Superseded rows are kept for audit (with
      --               superseded_by → newer row).
      -- pinned:       0/1. User pin always loads regardless of rank.
      -- reference_count + last_referenced_at: usage signals updated
      --               whenever a memory is included in an assembled
      --               system prompt or recalled. Drive recency-based
      --               ranking and aging (post-v1).
      --
      -- The application enforces enum values; SQLite TEXT is permissive.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS memories (
        id                  TEXT    PRIMARY KEY,
        profile_id          TEXT    NOT NULL,
        scope               TEXT    NOT NULL DEFAULT 'agent',
        scope_id            TEXT,
        kind                TEXT    NOT NULL DEFAULT 'fact',
        content             TEXT    NOT NULL,
        source              TEXT    NOT NULL,
        source_thread_id    TEXT,
        source_proposal_id  TEXT,
        confidence          REAL    NOT NULL DEFAULT 1.0,
        status              TEXT    NOT NULL DEFAULT 'active',
        superseded_by       TEXT,
        pinned              INTEGER NOT NULL DEFAULT 0,
        reference_count     INTEGER NOT NULL DEFAULT 0,
        last_referenced_at  TEXT,
        created_at          TEXT    NOT NULL,
        updated_at          TEXT    NOT NULL
      );

      -- Primary read path: ranking query for assembler.
      --   WHERE profile_id=? AND status='active'
      --   ORDER BY pinned DESC, last_referenced_at DESC NULLS LAST,
      --            confidence DESC, created_at DESC
      --   LIMIT ?
      -- Composite index covers the WHERE + ORDER BY columns.
      CREATE INDEX IF NOT EXISTS idx_memories_profile_active
        ON memories(profile_id, status, pinned DESC, last_referenced_at DESC, confidence DESC, created_at DESC);

      -- "List archived for this profile" / status filter UI views.
      CREATE INDEX IF NOT EXISTS idx_memories_profile_status
        ON memories(profile_id, status, updated_at DESC);

      -- Supersession chain lookups.
      CREATE INDEX IF NOT EXISTS idx_memories_superseded_by
        ON memories(superseded_by)
        WHERE superseded_by IS NOT NULL;

      -- ── memory_proposals ─────────────────────────────────────────
      -- Approval queue. Agent's \`remember()\` writes a 'pending' row.
      -- User accepts / rejects / edits via the gateway. On accept,
      -- the proposal becomes a memories row; resolved_memory_id links
      -- back so the UI can show "this memory came from thread X turn Y".
      --
      -- Why not write directly into \`memories\` and flag as pending?
      -- Audit + UX: a proposal is a transient request, a memory is a
      -- durable fact. Different lifecycles, different read patterns —
      -- keeping them in separate tables means the assembler's hot-path
      -- ranking query never has to filter out pending rows, and the
      -- proposals UI never has to scan the (much larger) memories table.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS memory_proposals (
        id                  TEXT    PRIMARY KEY,
        profile_id          TEXT    NOT NULL,
        thread_id           TEXT    NOT NULL,
        proposed_content    TEXT    NOT NULL,
        proposed_kind       TEXT    NOT NULL DEFAULT 'fact',
        status              TEXT    NOT NULL DEFAULT 'pending',
        resolved_content    TEXT,
        resolved_memory_id  TEXT,
        rejection_reason    TEXT,
        created_at          TEXT    NOT NULL,
        resolved_at         TEXT
      );

      -- "List pending proposals for this profile" — primary admin view.
      CREATE INDEX IF NOT EXISTS idx_memory_proposals_profile_pending
        ON memory_proposals(profile_id, status, created_at DESC);

      -- "Show proposals from this thread" — used by the inline approval
      -- card surface inside an active conversation.
      CREATE INDEX IF NOT EXISTS idx_memory_proposals_thread
        ON memory_proposals(thread_id, status, created_at DESC);

      -- ── user_identity ────────────────────────────────────────────
      -- Single-row table. Global identity facts that apply to EVERY
      -- profile (the "About you" panel in Settings). Auto-prepended
      -- to the system prompt at assembly time so a fresh profile
      -- already knows the user's name, role, timezone, etc.
      --
      -- Why a table and not user_settings KV? Structured fields read
      -- cleanly into a Zod schema; the UI surfaces specific labelled
      -- inputs; updates are atomic. The free-form \`preferences\`
      -- column absorbs the long tail.
      --
      -- The \`id\` column is fixed to the literal 'singleton' to keep
      -- the table physically a single row regardless of how many
      -- accidental INSERTs the application emits.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS user_identity (
        id          TEXT    PRIMARY KEY,
        name        TEXT,
        role        TEXT,
        company     TEXT,
        timezone    TEXT,
        pronouns    TEXT,
        preferences TEXT,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        CHECK (id = 'singleton')
      );
    `,
  },
  {
    version: 19,
    name: '019_connector_connections_entity_id_not_null',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Make connector_connections.entity_id NOT NULL.
      --
      -- Pre-v19 three independent code paths each chose their own
      -- default for entity_id (connect handler used NULL, the connector
      -- source used NULL, the composio tool-adapter used
      -- 'cortex-default-user'). Rows were written under one identity
      -- and read under another, surfacing as "Gmail looks connected in
      -- the Tools modal but the agent says not_connected" — the modal
      -- saw the NULL row, the agent looked for 'cortex-default-user'
      -- and missed.
      --
      -- The application-level fix routes every read/write through
      -- InstallIdentity (always non-empty). This migration enforces
      -- the same invariant at the storage layer:
      --
      --   1. Backfill: any pre-existing NULL row is adopted by the
      --      single-user install identity. Safe because v1 is single-
      --      user and no production install has overridden
      --      OWNWARE_COMPOSIO_USER_ID — every NULL row was written by
      --      the buggy path and belongs to the default identity.
      --
      --   2. Recreate the table with entity_id TEXT NOT NULL. SQLite
      --      cannot ALTER COLUMN, so the standard table-rename /
      --      copy / drop / recreate-indexes pattern is the only path.
      --
      -- After this migration, the schema itself rejects the bug — a
      -- regression to the "forgot to pass entityId" code path fails
      -- at INSERT time with a NOT NULL constraint violation rather
      -- than silently writing an unfindable row.
      -- ────────────────────────────────────────────────────────────

      -- 1. Heal existing rows.
      UPDATE connector_connections
         SET entity_id = 'cortex-default-user'
       WHERE entity_id IS NULL;

      -- 2. Recreate with NOT NULL on entity_id. Column order, types,
      --    and constraints otherwise identical to migrations 8 + 9.
      ALTER TABLE connector_connections RENAME TO _connector_connections_v18;

      CREATE TABLE connector_connections (
        connection_id   TEXT        PRIMARY KEY,
        connector_id    TEXT        NOT NULL,
        source          TEXT        NOT NULL,
        entity_id       TEXT        NOT NULL,
        status          TEXT        NOT NULL,
        initiated_at    INTEGER     NOT NULL,
        completed_at    INTEGER,
        last_polled_at  INTEGER,
        expires_at      INTEGER,
        error_reason    TEXT,
        metadata_json   TEXT,
        auth_config_id  TEXT
      );

      INSERT INTO connector_connections (
        connection_id, connector_id, source, entity_id, status,
        initiated_at, completed_at, last_polled_at, expires_at,
        error_reason, metadata_json, auth_config_id
      )
      SELECT
        connection_id, connector_id, source, entity_id, status,
        initiated_at, completed_at, last_polled_at, expires_at,
        error_reason, metadata_json, auth_config_id
      FROM _connector_connections_v18;

      DROP TABLE _connector_connections_v18;

      -- Recreate indexes (DROP TABLE removed the originals).
      CREATE INDEX IF NOT EXISTS idx_connector_connections_lookup
        ON connector_connections(connector_id, source, entity_id);
      CREATE INDEX IF NOT EXISTS idx_connector_connections_status
        ON connector_connections(status, expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_connections_one_live
        ON connector_connections(connector_id, source, entity_id)
        WHERE status IN ('pending','ready');
    `,
  },
  {
    version: 20,
    name: '020_messages_model',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Per-message model attribution.
      --
      -- Each assistant turn records the canonical model id that
      -- produced it (e.g. 'claude-sonnet-4-6', 'gpt-5.4', 'kimi-k-2.6').
      -- This makes the per-message brain badge in chat history a
      -- permanent fact, surviving reloads, app restarts, and future
      -- cloud sync — instead of being inferred at runtime from a global
      -- "current model" Zustand store that resets on refresh.
      --
      -- Rules (enforced in code, documented here so the schema's
      -- intent stays clear):
      --
      --   1. Set at INSERT time, never UPDATEd. A regenerate creates
      --      a NEW row marked superseded; the old row's model is
      --      preserved as historical fact.
      --   2. Stores the model the run was DISPATCHED with (request →
      --      thread → profile precedence), not what the provider's
      --      response envelope reported. Provider-side aliasing /
      --      silent routing must not retroactively change history.
      --   3. Nullable: pre-feature messages, user messages, and any
      --      future role that doesn't have a model attribution all
      --      legitimately have NULL here. The renderer falls back to
      --      a generic 'agent' label.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE messages ADD COLUMN model TEXT;
    `,
  },
  {
    version: 21,
    name: '021_connector_vendor_identity',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Vendor-frozen identity columns on connector_connections.
      --
      -- Every OAuth connection has TWO identity strings: one we
      -- control (entity_id, can migrate over time) and one the vendor
      -- froze at connect-time (cannot be rewritten without a new
      -- OAuth). Pre-021 we only stored the first; the vendor's
      -- identity lived in metadata_json (composioConnectedAccountId)
      -- or wasn't stored at all (Composio's user_id we sent at
      -- connect-time). When entity_id later migrated (this happened
      -- in migration 019), tool execution started failing on legacy
      -- rows because we sent our migrated entity_id as user_id and
      -- it didn't match what the vendor still had on file.
      --
      -- This migration promotes vendor identity to first-class
      -- columns so the type system can enforce the rule "vendor
      -- values are frozen, our values aren't, only send vendor
      -- values back to the vendor at execute-time."
      --
      --   • vendor_account_id — the unambiguous pointer the vendor
      --     issued (Composio's connected_account_id). Frozen at
      --     connect, used by the resolver at execute-time. Backfilled
      --     for existing rows from metadata.composioConnectedAccountId
      --     so legacy connections work without a reconnect.
      --   • vendor_user_id — what we sent to the vendor as their
      --     "user_id" at connect-time. We capture this so if the
      --     vendor's API ever requires it on refresh / execute we can
      --     send the value frozen at connect-time, NOT the live
      --     entity_id. NULL for legacy rows where we didn't record
      --     it; the resolver handles null cleanly.
      --
      -- Both nullable: not every source has these concepts (MCP /
      -- custom_mcp / builtin don't). Composio is the only source
      -- where they're meaningfully populated today.
      --
      -- The architectural rule is enforced by the per-source
      -- ConnectorIdentityResolver in src/connector/identity/.
      -- ────────────────────────────────────────────────────────────

      ALTER TABLE connector_connections ADD COLUMN vendor_account_id TEXT;
      ALTER TABLE connector_connections ADD COLUMN vendor_user_id TEXT;

      -- Backfill vendor_account_id for existing Composio rows from the
      -- metadata blob where it has historically lived. Only ready /
      -- pending rows matter (terminal rows are kept for audit but the
      -- resolver never reads them).
      UPDATE connector_connections
         SET vendor_account_id = json_extract(metadata_json, '$.composioConnectedAccountId')
       WHERE source = 'composio'
         AND status IN ('ready', 'pending')
         AND json_extract(metadata_json, '$.composioConnectedAccountId') IS NOT NULL;

      -- We do NOT backfill vendor_user_id. We don't know with certainty
      -- what we sent to Composio at connect time for legacy rows; the
      -- resolver routes through vendor_account_id which is sufficient
      -- for executeTool. NULL here is a deliberate "we don't have this
      -- value" signal, not an error.
    `,
  },
  {
    version: 22,
    name: '022_dedup_mcp_servers_by_logical_key',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- DB-level dedup of duplicate mcp_servers rows by logical key.
      --
      -- Phase 1 of the connector-unification board (2026-04-27) added
      -- read-time dedup in the registry + write-time dedup in the
      -- /mcp/register handler. But existing installs may already have
      -- multiple rows for the same logical app from before the fix:
      -- e.g. an auto-detected 'figma' (registry_id='detected') and a
      -- user-registered 'figma-c4vrjq3w' (registry_id='custom') both
      -- representing Figma. The read-time dedup hides them but they
      -- still bloat the DB and confuse downstream tooling that walks
      -- the table directly.
      --
      -- This migration consolidates each duplicate group into a single
      -- winning row, preserving every profile assignment that any
      -- variant had.
      --
      -- ALGORITHM (per logical-key group):
      --
      --   1. Compute the logical key for each candidate row. We can't
      --      call the TS helper from SQL, so we inline the rule:
      --        — for custom_mcp rows (registry_id='custom'): strip the
      --          trailing '-[a-z2-7]{8}' suffix.
      --        — for detected rows (registry_id='detected'): id is
      --          already a stable slug.
      --        — for everything else: id IS the logical key.
      --   2. Pick the winning row per group:
      --        — prefer detected over custom (auto-detect implies the
      --          app was actually found on the user's Mac).
      --        — within the same registry_id tier, prefer the row with
      --          a vendor_account_id in connector_connections (i.e. a
      --          live OAuth connection).
      --        — fall back to lowest id alphabetical (deterministic).
      --   3. Migrate every profile_mcp_servers (server_id IN losers)
      --      assignment to the winner.
      --   4. Delete the loser rows.
      --
      -- We do NOT touch entries under registry_id NULL or featured ids
      -- (those represent profile-driven sync rows that the boot
      -- reconciler already cleans up via Phase 5.2).
      -- ────────────────────────────────────────────────────────────

      -- Step 1: build a temp table of logical keys per row.
      CREATE TEMP TABLE _logical_keys AS
      SELECT
        id,
        registry_id,
        CASE
          WHEN registry_id = 'custom' AND id GLOB '*-????????'
               AND substr(id, length(id) - 7, 8) NOT GLOB '*[^a-z2-7]*'
            THEN substr(id, 1, length(id) - 9)
          ELSE id
        END AS logical_key
      FROM mcp_servers
      WHERE registry_id IN ('custom', 'detected');

      -- Step 2: pick a winner per logical_key group.
      -- Precedence: detected > custom; within-tier: vendor_account_id
      -- wins; tie-break by id alphabetical. Singletons emit a row whose
      -- winner_id equals its own id; the loser DELETEs below match
      -- "id != winner_id" so singletons are a no-op naturally.
      CREATE TEMP TABLE _dedup_winners AS
      SELECT logical_key, id AS winner_id
      FROM (
        SELECT
          lk.logical_key,
          lk.id,
          lk.registry_id,
          ROW_NUMBER() OVER (
            PARTITION BY lk.logical_key
            ORDER BY
              CASE WHEN lk.registry_id = 'detected' THEN 0 ELSE 1 END,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM connector_connections cc
                  WHERE cc.connector_id = lk.id
                    AND cc.status IN ('ready', 'pending')
                    AND cc.vendor_account_id IS NOT NULL
                ) THEN 0 ELSE 1
              END,
              lk.id ASC
          ) AS rn
        FROM _logical_keys lk
      ) ranked
      WHERE rn = 1;

      -- Step 3: migrate profile assignments from losers to winners.
      -- INSERT OR IGNORE because the winner may already be assigned to
      -- the profile (composite PK enforces uniqueness).
      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
      SELECT pms.profile_id, w.winner_id, pms.added_at
      FROM profile_mcp_servers pms
      JOIN _logical_keys lk ON lk.id = pms.server_id
      JOIN _dedup_winners w ON w.logical_key = lk.logical_key
      WHERE pms.server_id != w.winner_id;

      -- Step 4: drop the loser assignments.
      DELETE FROM profile_mcp_servers
      WHERE server_id IN (
        SELECT lk.id
        FROM _logical_keys lk
        JOIN _dedup_winners w ON w.logical_key = lk.logical_key
        WHERE lk.id != w.winner_id
      );

      -- Step 5: delete the loser mcp_servers rows.
      DELETE FROM mcp_servers
      WHERE id IN (
        SELECT lk.id
        FROM _logical_keys lk
        JOIN _dedup_winners w ON w.logical_key = lk.logical_key
        WHERE lk.id != w.winner_id
      );

      -- Step 6: clean up temp tables.
      DROP TABLE _dedup_winners;
      DROP TABLE _logical_keys;
    `,
  },
  {
    version: 23,
    name: '023_drop_legacy_bridge_rows',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Drop legacy mcp_servers rows that came from the old bridge
      -- auto-register write path.
      --
      -- Background (Milestone B Phase 12 — connector architecture
      -- unification, 2026-05-01):
      --
      --   Pre-Phase 11, gateway boot scanned ~/.ownware/bridges/ and
      --   wrote each manifest as a row in mcp_servers with
      --   registry_id='detected'. Phase 11 deleted that scanner;
      --   bridges now flow through connector/bridge-catalog.ts as a
      --   runtime-augmented overlay instead of DB rows.
      --
      --   The auto-register code was actually never called from
      --   shipping code (it was wired-in but unused), so most installs
      --   will have zero matching rows. This migration is defensive —
      --   if any developer manually triggered the path, those rows
      --   are still in the DB and would now be invisible to the
      --   registry (since CustomMCPSourceProvider's filter doesn't
      --   match 'detected', and the new bridge-catalog reader doesn't
      --   read the table at all).
      --
      -- HEURISTIC: bridges are uniquely identifiable as
      --   registry_id='detected' AND transport='http' AND url starts
      --   with http://127.0.0.1: or http://localhost:.
      --   Other detected sources (Spotlight, Claude Desktop, Claude
      --   Code) point at npm packages or remote URLs — never
      --   localhost.
      --
      -- IDEMPOTENT: re-running this migration after the rows are gone
      -- is a harmless no-op.
      --
      -- ────────────────────────────────────────────────────────────

      DELETE FROM mcp_servers
      WHERE registry_id = 'detected'
        AND transport = 'http'
        AND (
          url LIKE 'http://127.0.0.1:%'
          OR url LIKE 'http://localhost:%'
        );
    `,
  },
  {
    version: 24,
    name: '024_workspace_panes',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Universal pane substrate.
      --
      -- Every right-hand surface in a workspace (chat tabs, agent-
      -- opened viewers, side-panel tools — terminal/files/tasks/plan)
      -- becomes a typed pane row. Replaces the workspace_tabs model:
      -- one canonical, server-persisted store.
      --
      -- Wave 1a ships this table alongside workspace_tabs (the legacy
      -- table stays alive as a read-only fallback so existing clients
      -- don't break). Wave 1b cuts the client over to the new API; a
      -- follow-up migration drops workspace_tabs.
      --
      -- Back-fill (below): existing workspace_tabs rows of
      -- kind='thread' become workspace_panes rows of kind='chat'. The
      -- chat pane's config carries (profileId, threadId) — the JOIN to
      -- threads derives profileId, which workspace_tabs doesn't store.
      -- Non-thread tabs (kind in 'profile'|'settings'|'welcome') are
      -- not back-filled — no current code path appears to create them.
      -- ────────────────────────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS workspace_panes (
        id              TEXT      PRIMARY KEY,
        workspace_id    TEXT      NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind            TEXT      NOT NULL,
        zone            TEXT      NOT NULL,
        title           TEXT      NOT NULL,
        -- PaneConfig serialized as JSON; validated against
        -- PaneConfigSchema before write. Read paths use json_extract
        -- (better-sqlite3 ships JSON1) for index expressions.
        config_json     TEXT      NOT NULL,
        -- PaneMetadata serialized as JSON; validated against
        -- PaneMetadataSchema before write. The fields below denormalize
        -- the queryable subset out of metadata for indexing — JSON
        -- remains the source of truth, the columns mirror it.
        metadata_json   TEXT      NOT NULL,
        position        INTEGER   NOT NULL DEFAULT 0,
        focused         INTEGER   NOT NULL DEFAULT 0,
        pinned          INTEGER   NOT NULL DEFAULT 0,
        -- "Pane visible only when this chat pane is focused." NULL
        -- means visible regardless of chat focus (pinned globally).
        scoped_chat_id  TEXT,
        -- Dockview group assignment when the serialized layout
        -- exists. NULL until first layout write.
        group_id        TEXT,
        -- Denormalized for "show me sub-agent's panes" / "show me
        -- agent-opened panes" filters.
        opened_by       TEXT      NOT NULL DEFAULT 'user',
        subagent_id     TEXT,
        opened_at       TEXT      NOT NULL DEFAULT (datetime('now'))
      );

      -- Stable ordering inside a zone — primary read pattern is "all
      -- panes in (workspace, zone) sorted by position".
      CREATE INDEX IF NOT EXISTS idx_workspace_panes_zone
        ON workspace_panes(workspace_id, zone, position ASC);

      -- "Exactly one focused per (workspace, zone)." Mirrors
      -- workspace_tabs' one-active invariant. Zero focused is allowed
      -- (empty workspace); the partial unique index blocks two
      -- simultaneous focuses.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_panes_one_focused
        ON workspace_panes(workspace_id, zone)
        WHERE focused = 1;

      -- "No duplicate chat panes for the same thread per workspace."
      -- Mirrors workspace_tabs' (workspace_id, thread_id) uniqueness.
      -- Expression index on json_extract; better-sqlite3 supports it
      -- via SQLite's JSON1 extension (built-in since 3.38).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_panes_chat_thread
        ON workspace_panes(workspace_id, json_extract(config_json, '$.threadId'))
        WHERE kind = 'chat';

      -- Lookups for "panes scoped to this chat pane" — used when
      -- switching chat tabs to decide which agent-opened groups hide.
      CREATE INDEX IF NOT EXISTS idx_workspace_panes_scoped_chat
        ON workspace_panes(workspace_id, scoped_chat_id)
        WHERE scoped_chat_id IS NOT NULL;

      -- Lookups for "panes a sub-agent owns" — drives the colored
      -- sub-agent tab group + dissolve-on-spawn-end behaviour.
      CREATE INDEX IF NOT EXISTS idx_workspace_panes_subagent
        ON workspace_panes(workspace_id, subagent_id)
        WHERE subagent_id IS NOT NULL;

      -- ────────────────────────────────────────────────────────────
      -- Back-fill: chat tabs → chat panes.
      --
      -- Idempotent via the NOT EXISTS guard against the chat-thread
      -- uniqueness index — re-running the migration after rows exist
      -- is a harmless no-op.
      --
      -- Skips:
      --   * non-thread kinds (no defined pane mapping)
      --   * thread_id = NULL (orphaned tabs, already cleaned up by
      --     migration 007 — defensive only)
      --   * threads whose profile_id is NULL — schema says NOT NULL,
      --     so this should never fire, but the predicate keeps the
      --     migration safe in pathological databases.
      --
      -- Preserves: position, focused (mirrors active), opened_at
      -- (mirrors created_at), label as title.
      -- ────────────────────────────────────────────────────────────
      INSERT INTO workspace_panes (
        id, workspace_id, kind, zone, title, config_json, metadata_json,
        position, focused, pinned, opened_by, opened_at
      )
      SELECT
        'pane_' || lower(hex(randomblob(8))),
        wt.workspace_id,
        'chat',
        'tabs',
        wt.label,
        json_object(
          'kind',      'chat',
          'profileId', t.profile_id,
          'threadId',  wt.thread_id
        ),
        '{"openedBy":"user","pinned":false,"closeable":true}',
        wt.position,
        wt.active,
        0,
        'user',
        wt.created_at
      FROM workspace_tabs wt
      INNER JOIN threads t ON t.id = wt.thread_id
      WHERE wt.kind = 'thread'
        AND wt.thread_id IS NOT NULL
        AND t.profile_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM workspace_panes wp
          WHERE wp.workspace_id = wt.workspace_id
            AND wp.kind = 'chat'
            AND json_extract(wp.config_json, '$.threadId') = wt.thread_id
        );
    `,
  },
  {
    version: 25,
    name: '025_drop_workspace_tabs',
    sql: `
      -- Wave 1b.9: drop the legacy workspace_tabs table now that
      -- workspace_panes (migration 024) is the canonical store and
      -- the back-fill has run on every existing DB. After this
      -- migration, every chat that used to live as a workspace_tabs
      -- row exists as a workspace_panes row of kind='chat' (the
      -- migration-024 INSERT...SELECT...WHERE NOT EXISTS guarantees
      -- this; its 16-test suite covers idempotency, partial coverage,
      -- and the focused/active invariants).
      --
      -- One-way: there is no rollback. The client after wave 1b.7 never
      -- calls /workspaces/:id/tabs; the route registrations + handlers
      -- + state wrappers + types + schemas are deleted in this same
      -- slice.
      --
      -- Indices are dropped first because SQLite would auto-drop them
      -- with the table anyway, but explicit DROP INDEX matches the
      -- way they were explicitly created in migration 7 and keeps
      -- the migration log readable.
      DROP INDEX IF EXISTS idx_workspace_tabs_one_active;
      DROP INDEX IF EXISTS idx_workspace_tabs_thread_unique;
      DROP INDEX IF EXISTS idx_workspace_tabs_ws;
      DROP TABLE IF EXISTS workspace_tabs;
    `,
  },
  {
    version: 26,
    name: '026_mcp_servers_env_column',
    sql: `
      -- Phase 16-bis (2026-05-11): persist declared env-var NAMES for
      -- custom stdio MCP servers. Pre-migration, env names entered at
      -- POST /api/v1/mcp/register were silently dropped — they never
      -- reached the row, so the catalog hydrator couldn't see that
      -- the server needed credentials and computed auth.mode='none',
      -- which propagates to status='ready' even when no token was set.
      --
      -- Stored as JSON of Record<string, string> — same shape as the
      -- existing 'headers' column. Keys are env-var names; values are
      -- placeholder empty strings at register time. Real values live
      -- in the credential vault and are merged in at session-spawn.
      --
      -- Nullable column → existing rows hydrate as {} (treated as
      -- "no declared env" by mapMCPServer). No data migration needed.
      ALTER TABLE mcp_servers ADD COLUMN env TEXT;
    `,
  },
  {
    version: 27,
    name: '027_messages_cache_tokens',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Cache-token persistence on messages.
      --
      -- Phase 4f (2026-05-14) of context-compaction-ux: the live
      -- agent loop reports four token fields on every turn —
      -- inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens.
      -- Pre-migration, the messages table only stored the first two;
      -- cache fields were silently dropped at the persistence
      -- boundary, then re-defaulted to 0 by the client's reducer at
      -- /hydrate time (run.ts:801, 881).
      --
      -- Why it matters: the client's context-fill indicator computes
      -- window-fill as inputTokens + cacheReadTokens + cacheCreationTokens.
      -- With cache fields zeroed on hydrate, the indicator reads
      -- only the cache-MISS delta — typically a few hundred tokens
      -- after the prompt cache warms up — and shows '0% · 400k' even
      -- when the model just processed 100K+ tokens of context. The
      -- OpenAI provider in loom (openai.ts:345) intentionally splits
      -- the prompt count into cache-miss vs cache-read for billing
      -- accuracy; the indicator needs the SUM, so both halves must
      -- survive persistence.
      --
      -- Both columns are nullable: legacy rows (pre-027), user rows,
      -- system rows, and any future role that doesn't have model-side
      -- usage all legitimately stay NULL. The reader (mapMessage)
      -- coerces NULL → 0 to keep the wire shape stable.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE messages ADD COLUMN usage_cache_read INTEGER;
      ALTER TABLE messages ADD COLUMN usage_cache_creation INTEGER;
    `,
  },
  {
    version: 28,
    name: '028_connector_connections_last_verified_at',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Per-connection last-verified timestamp.
      --
      -- F4.c-1 (2026-05-16): adds the second-half of the status
      -- taxonomy migration. The wire enum already split a single
      -- 'error' into 'stale' (transient, auto-retries) and 'auth_error'
      -- (revoked, requires reauthorize). To pick between them the UI
      -- needs to know WHEN the connector was last seen as healthy —
      -- otherwise a freshly-revoked connection looks identical to one
      -- that's been broken for a week.
      --
      -- 'last_polled_at' (migration 008) is set on every poller tick
      -- regardless of outcome, so it doesn't carry the
      -- "successfully verified" signal. 'last_verified_at' is updated
      -- ONLY when a reconcile confirms the row matches its source of
      -- truth (Composio listConnectedAccounts returned ACTIVE; MCP
      -- tools/list round-tripped). Unix-ms integer, nullable for rows
      -- that have never been verified yet (fresh inserts, terminal
      -- failed/expired rows).
      --
      -- Read by the connector registry when projecting a wire
      -- Connector record so the client's UI can show "Last checked 3m
      -- ago" beneath stale rows.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE connector_connections ADD COLUMN last_verified_at INTEGER;
    `,
  },
  {
    version: 29,
    name: '029_rename_core_profiles_default_coder',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Rename core profiles: 'default' → 'ownware', 'coder' → 'ownware-code'.
      --
      -- 2026-05-19: PR A of the Ownware brand-prefix rename. The bundle
      -- dirs at packages/cortex/profiles/{default,coder} were renamed to
      -- {ownware,ownware-code}. Existing users have rows pointing at the
      -- old names in 8 tables + workspace_panes.config_json (chat panes
      -- carry profileId in JSON). Flip them in one transaction so the
      -- UI doesn't see a moment where threads point at a profile that
      -- no longer resolves.
      --
      -- 'INSERT OR IGNORE' shape for composite-PK tables: if a row with
      -- the new name already exists (unlikely but possible — a hand-
      -- edited DB, or a re-run of the migration), the duplicate is
      -- dropped silently. Otherwise the UPDATE flips it cleanly.
      --
      -- json_set updates workspace_panes.config_json IN-PLACE for chat
      -- panes whose JSON profileId matches the old name. Non-chat
      -- panes and panes without profileId are untouched (json_set on a
      -- non-existent path is a no-op — confirmed via SQLite JSON1 docs).
      -- ────────────────────────────────────────────────────────────

      -- threads: simple column update.
      UPDATE threads SET profile_id = 'ownware'      WHERE profile_id = 'default';
      UPDATE threads SET profile_id = 'ownware-code' WHERE profile_id = 'coder';

      -- usage_records: simple column update.
      UPDATE usage_records SET profile_id = 'ownware'      WHERE profile_id = 'default';
      UPDATE usage_records SET profile_id = 'ownware-code' WHERE profile_id = 'coder';

      -- workspaces.last_profile_id: nullable, safe direct UPDATE.
      UPDATE workspaces SET last_profile_id = 'ownware'      WHERE last_profile_id = 'default';
      UPDATE workspaces SET last_profile_id = 'ownware-code' WHERE last_profile_id = 'coder';

      -- workspace_profiles: composite PK (workspace_id, profile_id).
      -- INSERT-then-DELETE pattern preserves thread_count + last_used_at
      -- by merging into any pre-existing target row.
      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'default';
      DELETE FROM workspace_profiles WHERE profile_id = 'default';

      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-code', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'coder';
      DELETE FROM workspace_profiles WHERE profile_id = 'coder';

      -- profile_mcp_servers: composite PK (profile_id, server_id).
      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware', server_id, added_at
        FROM profile_mcp_servers WHERE profile_id = 'default';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'default';

      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-code', server_id, added_at
        FROM profile_mcp_servers WHERE profile_id = 'coder';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'coder';

      -- profile_metadata: PK is profile_id. Same INSERT-OR-IGNORE shape.
      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware', icon, color, category, updated_at
        FROM profile_metadata WHERE profile_id = 'default';
      DELETE FROM profile_metadata WHERE profile_id = 'default';

      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-code', icon, color, category, updated_at
        FROM profile_metadata WHERE profile_id = 'coder';
      DELETE FROM profile_metadata WHERE profile_id = 'coder';

      -- memories: simple column update.
      UPDATE memories SET profile_id = 'ownware'      WHERE profile_id = 'default';
      UPDATE memories SET profile_id = 'ownware-code' WHERE profile_id = 'coder';

      -- memory_proposals: simple column update.
      UPDATE memory_proposals SET profile_id = 'ownware'      WHERE profile_id = 'default';
      UPDATE memory_proposals SET profile_id = 'ownware-code' WHERE profile_id = 'coder';

      -- workspace_panes.config_json: chat panes carry profileId in JSON.
      -- Update IN-PLACE via json_set. Guarded by json_extract so we only
      -- touch rows whose profileId actually matches.
      UPDATE workspace_panes
         SET config_json = json_set(config_json, '$.profileId', 'ownware')
       WHERE json_extract(config_json, '$.profileId') = 'default';

      UPDATE workspace_panes
         SET config_json = json_set(config_json, '$.profileId', 'ownware-code')
       WHERE json_extract(config_json, '$.profileId') = 'coder';
    `,
  },
  {
    version: 30,
    name: '030_rename_marketplace_profiles',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Rename marketplace profiles to the ownware-* brand prefix.
      --
      -- 2026-05-19: PR B of the Ownware brand-prefix rename. The seven
      -- marketplace bundle dirs at packages/cortex/profiles/{counsel,
      -- finance, marketing, researcher, sentinel, trading-coach,
      -- trading-research} were renamed to ownware-* equivalents. Users
      -- who installed any of these via the Marketplace tab have rows
      -- referencing the old names; flip them in one transaction.
      --
      -- Same 9-table shape as migration 029. Composite-PK tables use
      -- INSERT OR IGNORE + DELETE to merge cleanly with any pre-
      -- existing target rows. JSON path inside workspace_panes is
      -- updated via json_set guarded by json_extract.
      -- ────────────────────────────────────────────────────────────

      -- threads.profile_id
      UPDATE threads SET profile_id = 'ownware-law'            WHERE profile_id = 'counsel';
      UPDATE threads SET profile_id = 'ownware-finance'        WHERE profile_id = 'finance';
      UPDATE threads SET profile_id = 'ownware-marketing'      WHERE profile_id = 'marketing';
      UPDATE threads SET profile_id = 'ownware-research'       WHERE profile_id = 'researcher';
      UPDATE threads SET profile_id = 'ownware-security'       WHERE profile_id = 'sentinel';
      UPDATE threads SET profile_id = 'ownware-trade-coach'    WHERE profile_id = 'trading-coach';
      UPDATE threads SET profile_id = 'ownware-trade-research' WHERE profile_id = 'trading-research';

      -- usage_records.profile_id
      UPDATE usage_records SET profile_id = 'ownware-law'            WHERE profile_id = 'counsel';
      UPDATE usage_records SET profile_id = 'ownware-finance'        WHERE profile_id = 'finance';
      UPDATE usage_records SET profile_id = 'ownware-marketing'      WHERE profile_id = 'marketing';
      UPDATE usage_records SET profile_id = 'ownware-research'       WHERE profile_id = 'researcher';
      UPDATE usage_records SET profile_id = 'ownware-security'       WHERE profile_id = 'sentinel';
      UPDATE usage_records SET profile_id = 'ownware-trade-coach'    WHERE profile_id = 'trading-coach';
      UPDATE usage_records SET profile_id = 'ownware-trade-research' WHERE profile_id = 'trading-research';

      -- workspaces.last_profile_id (nullable)
      UPDATE workspaces SET last_profile_id = 'ownware-law'            WHERE last_profile_id = 'counsel';
      UPDATE workspaces SET last_profile_id = 'ownware-finance'        WHERE last_profile_id = 'finance';
      UPDATE workspaces SET last_profile_id = 'ownware-marketing'      WHERE last_profile_id = 'marketing';
      UPDATE workspaces SET last_profile_id = 'ownware-research'       WHERE last_profile_id = 'researcher';
      UPDATE workspaces SET last_profile_id = 'ownware-security'       WHERE last_profile_id = 'sentinel';
      UPDATE workspaces SET last_profile_id = 'ownware-trade-coach'    WHERE last_profile_id = 'trading-coach';
      UPDATE workspaces SET last_profile_id = 'ownware-trade-research' WHERE last_profile_id = 'trading-research';

      -- workspace_profiles — composite PK; INSERT OR IGNORE then DELETE
      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-law', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'counsel';
      DELETE FROM workspace_profiles WHERE profile_id = 'counsel';

      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-finance', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'finance';
      DELETE FROM workspace_profiles WHERE profile_id = 'finance';

      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-marketing', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'marketing';
      DELETE FROM workspace_profiles WHERE profile_id = 'marketing';

      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-research', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'researcher';
      DELETE FROM workspace_profiles WHERE profile_id = 'researcher';

      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-security', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'sentinel';
      DELETE FROM workspace_profiles WHERE profile_id = 'sentinel';

      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-trade-coach', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'trading-coach';
      DELETE FROM workspace_profiles WHERE profile_id = 'trading-coach';

      INSERT OR IGNORE INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        SELECT workspace_id, 'ownware-trade-research', thread_count, last_used_at
        FROM workspace_profiles WHERE profile_id = 'trading-research';
      DELETE FROM workspace_profiles WHERE profile_id = 'trading-research';

      -- profile_mcp_servers — composite PK
      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-law', server_id, added_at FROM profile_mcp_servers WHERE profile_id = 'counsel';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'counsel';

      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-finance', server_id, added_at FROM profile_mcp_servers WHERE profile_id = 'finance';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'finance';

      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-marketing', server_id, added_at FROM profile_mcp_servers WHERE profile_id = 'marketing';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'marketing';

      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-research', server_id, added_at FROM profile_mcp_servers WHERE profile_id = 'researcher';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'researcher';

      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-security', server_id, added_at FROM profile_mcp_servers WHERE profile_id = 'sentinel';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'sentinel';

      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-trade-coach', server_id, added_at FROM profile_mcp_servers WHERE profile_id = 'trading-coach';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'trading-coach';

      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id, added_at)
        SELECT 'ownware-trade-research', server_id, added_at FROM profile_mcp_servers WHERE profile_id = 'trading-research';
      DELETE FROM profile_mcp_servers WHERE profile_id = 'trading-research';

      -- profile_metadata — PK is profile_id
      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-law', icon, color, category, updated_at FROM profile_metadata WHERE profile_id = 'counsel';
      DELETE FROM profile_metadata WHERE profile_id = 'counsel';

      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-finance', icon, color, category, updated_at FROM profile_metadata WHERE profile_id = 'finance';
      DELETE FROM profile_metadata WHERE profile_id = 'finance';

      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-marketing', icon, color, category, updated_at FROM profile_metadata WHERE profile_id = 'marketing';
      DELETE FROM profile_metadata WHERE profile_id = 'marketing';

      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-research', icon, color, category, updated_at FROM profile_metadata WHERE profile_id = 'researcher';
      DELETE FROM profile_metadata WHERE profile_id = 'researcher';

      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-security', icon, color, category, updated_at FROM profile_metadata WHERE profile_id = 'sentinel';
      DELETE FROM profile_metadata WHERE profile_id = 'sentinel';

      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-trade-coach', icon, color, category, updated_at FROM profile_metadata WHERE profile_id = 'trading-coach';
      DELETE FROM profile_metadata WHERE profile_id = 'trading-coach';

      INSERT OR IGNORE INTO profile_metadata (profile_id, icon, color, category, updated_at)
        SELECT 'ownware-trade-research', icon, color, category, updated_at FROM profile_metadata WHERE profile_id = 'trading-research';
      DELETE FROM profile_metadata WHERE profile_id = 'trading-research';

      -- memories.profile_id
      UPDATE memories SET profile_id = 'ownware-law'            WHERE profile_id = 'counsel';
      UPDATE memories SET profile_id = 'ownware-finance'        WHERE profile_id = 'finance';
      UPDATE memories SET profile_id = 'ownware-marketing'      WHERE profile_id = 'marketing';
      UPDATE memories SET profile_id = 'ownware-research'       WHERE profile_id = 'researcher';
      UPDATE memories SET profile_id = 'ownware-security'       WHERE profile_id = 'sentinel';
      UPDATE memories SET profile_id = 'ownware-trade-coach'    WHERE profile_id = 'trading-coach';
      UPDATE memories SET profile_id = 'ownware-trade-research' WHERE profile_id = 'trading-research';

      -- memory_proposals.profile_id
      UPDATE memory_proposals SET profile_id = 'ownware-law'            WHERE profile_id = 'counsel';
      UPDATE memory_proposals SET profile_id = 'ownware-finance'        WHERE profile_id = 'finance';
      UPDATE memory_proposals SET profile_id = 'ownware-marketing'      WHERE profile_id = 'marketing';
      UPDATE memory_proposals SET profile_id = 'ownware-research'       WHERE profile_id = 'researcher';
      UPDATE memory_proposals SET profile_id = 'ownware-security'       WHERE profile_id = 'sentinel';
      UPDATE memory_proposals SET profile_id = 'ownware-trade-coach'    WHERE profile_id = 'trading-coach';
      UPDATE memory_proposals SET profile_id = 'ownware-trade-research' WHERE profile_id = 'trading-research';

      -- workspace_panes.config_json — chat panes' JSON profileId
      UPDATE workspace_panes SET config_json = json_set(config_json, '$.profileId', 'ownware-law')            WHERE json_extract(config_json, '$.profileId') = 'counsel';
      UPDATE workspace_panes SET config_json = json_set(config_json, '$.profileId', 'ownware-finance')        WHERE json_extract(config_json, '$.profileId') = 'finance';
      UPDATE workspace_panes SET config_json = json_set(config_json, '$.profileId', 'ownware-marketing')      WHERE json_extract(config_json, '$.profileId') = 'marketing';
      UPDATE workspace_panes SET config_json = json_set(config_json, '$.profileId', 'ownware-research')       WHERE json_extract(config_json, '$.profileId') = 'researcher';
      UPDATE workspace_panes SET config_json = json_set(config_json, '$.profileId', 'ownware-security')       WHERE json_extract(config_json, '$.profileId') = 'sentinel';
      UPDATE workspace_panes SET config_json = json_set(config_json, '$.profileId', 'ownware-trade-coach')    WHERE json_extract(config_json, '$.profileId') = 'trading-coach';
      UPDATE workspace_panes SET config_json = json_set(config_json, '$.profileId', 'ownware-trade-research') WHERE json_extract(config_json, '$.profileId') = 'trading-research';
    `,
  },
  {
    version: 31,
    name: '031_drop_composio_catalog',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Drop the local Composio catalogue mirror.
      --
      -- 2026-05-21: Composio's toolkit catalogue is now fetched live
      -- via the v3 API (see connector/composio/catalog-cache.ts). The
      -- SQLite copy created in migration 008 ("composio_catalog") is
      -- redundant — every read path was migrated to the live cache in
      -- a multi-slice rip.
      --
      -- The table is a pure cache with no user-authored rows, so a
      -- straight DROP is lossless. Indexes go with the table.
      -- Forward-only — SQLite doesn't make CREATE TABLE rollback cheap,
      -- and the data is trivially re-derivable from the live API on
      -- the next listToolkits call.
      -- ────────────────────────────────────────────────────────────
      DROP INDEX IF EXISTS idx_composio_catalog_slug;
      DROP INDEX IF EXISTS idx_composio_catalog_category;
      DROP TABLE IF EXISTS composio_catalog;
    `,
  },
  {
    version: 32,
    name: '032_workspaces_active_products',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Product-base shift · Phase 2 · slice-01
      --
      -- 2026-05-23: a workspace can host one or more Ownware products
      -- (Coder / Design / Marketing / future verticals). Until now
      -- the only signal was \`workspace_profiles\` joined through
      -- \`profiles.productId\` — which collapses "enabled but no
      -- profiles wired yet" into "not enabled at all." This column
      -- carries the explicit truth.
      --
      -- Storage: JSON-encoded TEXT, NOT NULL, DEFAULT '["ownware"]'.
      -- SQLite backfills existing rows with the default at ADD COLUMN
      -- time, so every workspace previously created (single-product
      -- Ownware) is correct without a separate UPDATE pass.
      --
      -- Cortex does not validate slug contents against any registry;
      -- that coupling lives in the client (decision D-36).
      --
      -- Forward-only — SQLite DROP COLUMN requires table rebuild and
      -- the field is intended to live forever.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE workspaces
        ADD COLUMN active_products TEXT NOT NULL DEFAULT '["ownware"]';
    `,
  },
  {
    version: 33,
    name: '033_designs',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Ownware Design — per-design metadata
      --
      -- 2026-05-24: Design needs to remember its per-design metadata
      -- (kind, slug, template source, name) for the canvas dispatcher
      -- in studio + the strip's child-picker. Following root CLAUDE.md
      -- Principle 22 (new concerns get new verticals): this is a
      -- Design-PRODUCT-scoped table, NOT a generic "child_workspaces"
      -- abstraction. The threads table is untouched — Coder never
      -- queries the new tables. When Marketing later ships per-draft
      -- workspaces it gets its OWN tables (\`drafts\` + \`thread_drafts\`),
      -- never folded into a generic schema.
      --
      -- Forward-only. SQLite DROP TABLE is supported but the intent
      -- is for these to live forever.
      -- ────────────────────────────────────────────────────────────

      -- One row per design artifact in a parent workspace.
      CREATE TABLE IF NOT EXISTS designs (
        id              TEXT        PRIMARY KEY,
        workspace_id    TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        slug            TEXT        NOT NULL,
        kind            TEXT        NOT NULL,
        name            TEXT,
        template_source TEXT,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        UNIQUE (workspace_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_designs_workspace
        ON designs(workspace_id, updated_at DESC);

      -- Thread ↔ design join. PRIMARY KEY on thread_id means each
      -- thread belongs to at most one design (which matches the
      -- one-thread-per-design v1 model). Many threads per design is
      -- still possible — just changes the constraint when we want it.
      CREATE TABLE IF NOT EXISTS thread_designs (
        thread_id   TEXT        PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        design_id   TEXT        NOT NULL    REFERENCES designs(id) ON DELETE CASCADE,
        created_at  TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_thread_designs_design
        ON thread_designs(design_id);
    `,
  },
  {
    version: 34,
    name: '034_designs_repoint_to_own_folder_workspace',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Ownware Design — repoint designs at their OWN folder workspace
      --
      -- 2026-05-29: designs created before this fix stored
      -- \`workspace_id\` = the PARENT workspace (e.g. the user's project
      -- root). Every design-file endpoint resolves
      -- \`getWorkspace(design.workspace_id).path\` and walks it, so a
      -- parent-pointed design leaked every sibling design's files AND
      -- the parent project's own source into that design's canvas — and
      -- the slug-rename would \`fs.rename\` the parent folder. The fix
      -- (the client's useDesignRun) now points new designs at their per-design
      -- folder workspace at \`<parent>/.ownware/app/ownware-design/<slug>\`.
      --
      -- This migration backfills the old rows: for each design whose
      -- current workspace path is the PARENT (NOT already nested under a
      -- design folder), repoint it to the per-design folder workspace
      -- with the matching path, IF that workspace row exists. Rows whose
      -- folder workspace was never created are left untouched (honest —
      -- nothing to point at; they simply won't list).
      --
      -- Idempotent: after repointing, the design's path IS nested, so the
      -- guard below excludes it on any re-run. Forward-only.
      -- ────────────────────────────────────────────────────────────
      UPDATE designs
      SET workspace_id = (
        SELECT w2.id FROM workspaces w2
        WHERE w2.path =
          (SELECT w1.path FROM workspaces w1 WHERE w1.id = designs.workspace_id)
          || '/.ownware/app/ownware-design/' || designs.slug
      )
      WHERE
        (SELECT w1.path FROM workspaces w1 WHERE w1.id = designs.workspace_id)
          NOT LIKE '%/.ownware/app/ownware-design/%'
        AND EXISTS (
          SELECT 1 FROM workspaces w2
          WHERE w2.path =
            (SELECT w1.path FROM workspaces w1 WHERE w1.id = designs.workspace_id)
            || '/.ownware/app/ownware-design/' || designs.slug
        );
    `,
  },
  {
    version: 35,
    name: '035_teams',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent Teams — the team vertical's own tables
      --
      -- 2026-06-12: per root CLAUDE.md Principle 22, teams get their
      -- OWN vertical (cortex/src/team/), never columns on core tables.
      -- All tables are team_-prefixed: a generic "tasks" table already
      -- exists (migration 014, per-thread todo_write persistence) and
      -- is a different concept — an agent's private scratchpad, not
      -- the team's shared Board. The threads table is untouched: a
      -- team run binds to its thread via team_runs.thread_id (the
      -- designs + thread_designs join pattern from migration 033).
      --
      -- Removability: dropping team_* and deleting cortex/src/team/
      -- + the client's teams feature must leave every existing flow
      -- green (HANDOVER-1 acceptance test). Forward-only.
      -- ────────────────────────────────────────────────────────────

      -- Team configuration (built in the Companies section).
      CREATE TABLE IF NOT EXISTS teams (
        id              TEXT        PRIMARY KEY,
        name            TEXT        NOT NULL UNIQUE,
        display_name    TEXT        NOT NULL,
        charter         TEXT        NOT NULL DEFAULT '',
        conductor_name  TEXT        NOT NULL DEFAULT 'Juno',
        conductor_model TEXT,
        max_cost_usd    REAL,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      -- Roster: existing profiles bound into the team with a role.
      CREATE TABLE IF NOT EXISTS team_members (
        team_id         TEXT        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        slug            TEXT        NOT NULL,
        profile_id      TEXT        NOT NULL,
        role            TEXT        NOT NULL,
        instructions    TEXT,
        model           TEXT,
        position        INTEGER     NOT NULL DEFAULT 0,
        PRIMARY KEY (team_id, slug)
      );

      -- One run = one goal's lifecycle on one board, bound 1:1 to a
      -- thread (UNIQUE thread_id — loosen the constraint when a
      -- many-runs-per-thread model is actually needed, not before).
      CREATE TABLE IF NOT EXISTS team_runs (
        id              TEXT        PRIMARY KEY,
        team_id         TEXT        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        thread_id       TEXT        NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
        workspace_id    TEXT,
        status          TEXT        NOT NULL DEFAULT 'active',
        cost_usd        REAL        NOT NULL DEFAULT 0,
        -- Per-run budget cap. Seeded from teams.max_cost_usd at run
        -- creation; raised mid-run by the Conductor's set_budget after
        -- explicit user approval (S3 budget-pause flow). NULL = no cap.
        max_cost_usd    REAL,
        receipt         TEXT,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_team_runs_team
        ON team_runs(team_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_runs_status
        ON team_runs(status);

      -- The Board. Everything is a task (goal · work · question ·
      -- verify). seq is the per-run ordinal rendered as T1, T2, …
      -- JSON columns hold string arrays (deliverables, depends_on,
      -- resource_hints) — validated by zod in cortex/src/team/.
      CREATE TABLE IF NOT EXISTS team_tasks (
        id              TEXT        PRIMARY KEY,
        run_id          TEXT        NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        seq             INTEGER     NOT NULL,
        parent_id       TEXT,
        kind            TEXT        NOT NULL,
        title           TEXT        NOT NULL,
        brief           TEXT        NOT NULL DEFAULT '',
        done_criteria   TEXT        NOT NULL DEFAULT '',
        deliverables    TEXT        NOT NULL DEFAULT '[]',
        depends_on      TEXT        NOT NULL DEFAULT '[]',
        owner           TEXT,
        filed_by        TEXT        NOT NULL,
        resource_hints  TEXT        NOT NULL DEFAULT '[]',
        status          TEXT        NOT NULL DEFAULT 'draft',
        result          TEXT,
        blocked_reason  TEXT,
        created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT        NOT NULL DEFAULT (datetime('now')),
        UNIQUE (run_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_team_tasks_run
        ON team_tasks(run_id, seq ASC);
      CREATE INDEX IF NOT EXISTS idx_team_tasks_status
        ON team_tasks(run_id, status);

      -- Leases (D7/D8): single-writer-per-resource, derived from tool
      -- args at the checkPermission seam. Table ships now so the S2
      -- lease gate is purely additive code; no rows are written in S1.
      CREATE TABLE IF NOT EXISTS team_leases (
        run_id            TEXT      NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        resource_key      TEXT      NOT NULL,
        task_id           TEXT      NOT NULL,
        agent_id          TEXT      NOT NULL,
        last_activity_at  TEXT      NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, resource_key)
      );
    `,
  },
  {
    version: 36,
    name: '036_team_instruction_fragments',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent Teams — named instruction fragments (BOARD decision D26)
      --
      -- 2026-06-12: the inside-company screen authors the company's
      -- "brain" as plain-language pieces with human names — Identity ·
      -- Principles · Workflow · Done means · Rules · Voice — each its
      -- own focused editor. The legacy single \`charter\` column stays
      -- as the freeform fallback (pre-fragment teams keep working).
      -- The conductor materializer composes whichever are present.
      -- Separate migration (not amended into 035): 035 already ran on
      -- live databases.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE teams ADD COLUMN charter_identity   TEXT;
      ALTER TABLE teams ADD COLUMN charter_principles TEXT;
      ALTER TABLE teams ADD COLUMN charter_workflow   TEXT;
      ALTER TABLE teams ADD COLUMN charter_done_means TEXT;
      ALTER TABLE teams ADD COLUMN charter_rules      TEXT;
      ALTER TABLE teams ADD COLUMN charter_voice      TEXT;
    `,
  },
  {
    version: 37,
    name: '037_team_conductor_depth',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent Teams — conductor depth (inside-company conductor modal)
      --
      -- 2026-06-12: the lead's modal exposes two settings beyond Brain:
      -- an escalation stance ("When members are unsure") and free-text
      -- extra instructions. Both compose into the conductor's SOUL at
      -- materialization. Escalation defaults to 'balanced' so every
      -- pre-existing team keeps its current behavior.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE teams ADD COLUMN conductor_escalation   TEXT NOT NULL DEFAULT 'balanced';
      ALTER TABLE teams ADD COLUMN conductor_instructions TEXT;
    `,
  },
  {
    version: 38,
    name: '038_team_member_capability',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent Teams — per-member capability (inside-company member modal)
      --
      -- 2026-06-13: a member's autonomy is enforced as TOOL ACCESS, not
      -- a permission prompt — a headless team run has no human to answer
      -- a mid-task 'ask'. 'read-only' keeps only read tools; toolRestricts
      -- are deny-globs removed on top, applied at the cortex security
      -- boundary (profile/tool-policy). Defaults preserve every existing
      -- member's full surface.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE team_members ADD COLUMN autonomy       TEXT NOT NULL DEFAULT 'inherit';
      ALTER TABLE team_members ADD COLUMN tool_restricts TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 39,
    name: '039_team_surface',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent Teams — product surface (inside-company "Runs on")
      --
      -- 2026-06-13: which product the team's run opens in. Kernel
      -- metadata (a catalog slug, validated on write against the product
      -- manifest) — it stamps the materialized conductor's productId so
      -- the run renders in the right shell. It does NOT change member or
      -- conductor tool assembly (tools come from profile preset/policy).
      -- Defaults to 'ownware' (the general surface) for every existing
      -- team; coder-first teams set 'ownware-coder' explicitly.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE teams ADD COLUMN surface TEXT NOT NULL DEFAULT 'ownware';
    `,
  },
  {
    version: 40,
    name: '040_team_references',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent Teams — standing reference docs (inside-company
      -- "Knowledge & memory · Reference"). Own table (Principle 22),
      -- not a column: a team has 0..N docs, ordered. Injected (bounded)
      -- into the conductor SOUL + every member handoff so the whole team
      -- works from the same source. Cascades with the team.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS team_references (
        team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        name     TEXT NOT NULL,
        content  TEXT NOT NULL,
        PRIMARY KEY (team_id, position)
      );
    `,
  },
  {
    version: 41,
    name: '041_team_connectors',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Agent Teams — granted connectors (inside-company "Connectors").
      -- v1: Composio toolkit slugs granted to every member, merged
      -- additively into each member's own composio toolkits at assembly.
      -- The grant never bypasses auth — a member only gets a toolkit's
      -- tools if its entity has that toolkit connected. Own table
      -- (Principle 22), ordered, cascades. MCP-server grants are a
      -- separate future slice (need connector-id→config resolution).
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS team_connectors (
        team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        toolkit  TEXT NOT NULL,
        PRIMARY KEY (team_id, position)
      );
    `,
  },
  {
    version: 42,
    name: '042_boards',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Board — the top rung of the work ladder (todo → plan → BOARD).
      -- A board is a whole effort: a goal + approach + ordered SLICES
      -- the agent works one-by-one, plus FINDINGS (bugs/notes) logged
      -- mid-build.
      --
      -- SCOPING (decision D7): a board scopes to the WORKSPACE, not a
      -- thread — it outlives any single chat (pause in one session,
      -- resume in another) and the Board switcher lists every board in
      -- a workspace. \`origin_thread_id\` is a soft pointer back to the
      -- chat that drafted it (SET NULL if that thread is deleted).
      --
      -- FAILURE-SAFE WRITES (decision D6): \`board_write\` replaces the
      -- structure (board row + slices) in one transaction; slice status
      -- and findings are tiny atomic updates — never a full regenerate.
      -- Same enforce-enum-in-TypeScript discipline as tasks/messages.
      --
      -- LIFECYCLE status (board): draft | awaiting | running | paused |
      -- done | archived. Slice status: queued | running | done | failed
      -- | skipped. Finding status: open | deferred | resolved. All
      -- validated in TS before insert.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS boards (
        id                TEXT    PRIMARY KEY,
        workspace_id      TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        origin_thread_id  TEXT    REFERENCES threads(id) ON DELETE SET NULL,
        slug              TEXT    NOT NULL,
        title             TEXT    NOT NULL,
        goal              TEXT    NOT NULL DEFAULT '',
        approach          TEXT    NOT NULL DEFAULT '',
        status            TEXT    NOT NULL DEFAULT 'draft',
        created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- One board per (workspace, slug): re-drafting the same effort
      -- updates in place rather than spawning board-v2.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_ws_slug
        ON boards(workspace_id, slug);
      CREATE INDEX IF NOT EXISTS idx_boards_ws_updated
        ON boards(workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS board_slices (
        id          TEXT    PRIMARY KEY,
        board_id    TEXT    NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        title       TEXT    NOT NULL,
        summary     TEXT    NOT NULL DEFAULT '',
        plan        TEXT    NOT NULL DEFAULT '',
        evidence    TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'queued',
        list_order  INTEGER NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_board_slices_board
        ON board_slices(board_id, list_order ASC);

      CREATE TABLE IF NOT EXISTS board_findings (
        id          TEXT    PRIMARY KEY,
        board_id    TEXT    NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        slice_id    TEXT    REFERENCES board_slices(id) ON DELETE SET NULL,
        title       TEXT    NOT NULL,
        detail      TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'open',
        list_order  INTEGER NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_board_findings_board
        ON board_findings(board_id, list_order ASC);
    `,
  },
  {
    version: 43,
    name: '043_schedules',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Per-profile scheduling ("Ownware Calendar"). Its OWN vertical
      -- (Principle 22) — never columns on threads, never a JSON blob.
      --
      -- A schedule runs ONE profile on a cadence as a normal single-
      -- agent run (NOT a team). \`next_run_at\` (epoch ms) is the durable
      -- scheduling cursor / source of truth — the in-process timer is
      -- only an optimization; on every boot/tick we sweep for due rows.
      -- All time columns are epoch milliseconds (INTEGER) so the due-
      -- query is a plain numeric comparison and sorting is exact.
      --
      -- Storage-backed so the same shape ports to the BYO-cloud
      -- packaging (Postgres/D1) with no schema change.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS schedules (
        id                 TEXT    PRIMARY KEY,
        profile_id         TEXT    NOT NULL,
        workspace_id       TEXT,
        name               TEXT    NOT NULL,
        prompt             TEXT    NOT NULL,
        model              TEXT,
        -- cadence: kind in (once|interval|daily|weekly|weekdays|cron);
        -- expr is the canonical encoding (ISO ts for once, minutes for
        -- interval, cron string otherwise); display is plain-English.
        cadence_kind       TEXT    NOT NULL,
        cadence_expr       TEXT    NOT NULL,
        cadence_display    TEXT    NOT NULL,
        timezone           TEXT    NOT NULL,
        -- how a missed run is handled on reopen. Default 'catch-up'
        -- (run once when reopened); 'skip' = don't run late; 'window'
        -- = catch up only if missed by < catch_up_window_ms.
        catch_up_policy    TEXT    NOT NULL DEFAULT 'catch-up',
        catch_up_window_ms INTEGER,
        -- 'skip-if-running' (default) | 'allow' a self-overlapping run.
        overlap_policy     TEXT    NOT NULL DEFAULT 'skip-if-running',
        skip_weekends      INTEGER NOT NULL DEFAULT 0,
        skip_holidays      INTEGER NOT NULL DEFAULT 0,
        -- JSON pre-authorized tool envelope for unattended runs
        -- (auto-run reads / deny writes / notify-and-pause). NULL = the
        -- profile's normal policy. Wired in a later slice.
        tool_envelope      TEXT,
        enabled            INTEGER NOT NULL DEFAULT 1,
        -- 'scheduled' | 'paused' | 'completed' (one-off, fired) | 'error'
        state              TEXT    NOT NULL DEFAULT 'scheduled',
        next_run_at        INTEGER,
        last_run_at        INTEGER,
        last_run_id        TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      -- Hot path: the due-query (enabled AND next_run_at <= now).
      CREATE INDEX IF NOT EXISTS idx_schedules_due
        ON schedules(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_profile
        ON schedules(profile_id);

      -- ────────────────────────────────────────────────────────────
      -- Run-history ledger: one row per firing (incl. skips). The
      -- \`thread_id\` link is what makes "click a past run → open the
      -- thread" a one-liner (SET NULL if that thread is deleted, so the
      -- history row survives). run_status / delivery_status / skip_reason
      -- encode the "honest outcomes, never a fake fine" discipline
      -- (Principle 21) directly in the schema.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id              TEXT    PRIMARY KEY,
        schedule_id     TEXT    NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        thread_id       TEXT    REFERENCES threads(id) ON DELETE SET NULL,
        scheduled_for   INTEGER NOT NULL,
        started_at      INTEGER,
        finished_at     INTEGER,
        -- 'succeeded' | 'ran-empty' | 'failed-to-run' | 'failed-to-deliver' | 'skipped'
        run_status      TEXT    NOT NULL,
        skip_reason     TEXT,
        was_catch_up    INTEGER NOT NULL DEFAULT 0,
        error_category  TEXT,
        error_message   TEXT,
        -- 'delivered' | 'not-delivered' | 'unknown' | 'not-requested'
        delivery_status TEXT    NOT NULL DEFAULT 'not-requested',
        idempotency_key TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_runs_history
        ON schedule_runs(schedule_id, scheduled_for DESC);
    `,
  },
  {
    version: 44,
    name: '044_schedule_safety_level',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Per-schedule unattended safety envelope (Slice 8b). The level the
      -- create dialog's three cards bind to:
      --   'read-only'      → only read tools are handed to the run
      --   'draft-approval' → write/send tools are withheld (held for approval
      --                      once the 8d hold pipeline lands) — the DEFAULT, so
      --                      a scheduled run is safe unless the user opts up
      --   'full-access'    → every tool; the user explicitly opted in
      -- Capability is enforced as TOOL ACCESS at assembly (run.ts), never a
      -- permission prompt — a scheduled run is headless. Additive + non-
      -- destructive: a constant DEFAULT backfills every existing row safely.
      -- ────────────────────────────────────────────────────────────
      ALTER TABLE schedules
        ADD COLUMN safety_level TEXT NOT NULL DEFAULT 'draft-approval';
    `,
  },
  {
    version: 45,
    name: '045_schedule_approvals',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Held actions awaiting human approval (Slice 8c) — its OWN
      -- vertical (Principle 22), never columns on schedules / runs.
      --
      -- A 'draft-approval' scheduled run parks each write/send tool call
      -- HERE as a 'pending' row instead of executing it (the hold pipeline
      -- lands in 8d); the user approves → it executes (result recorded),
      -- or discards → it's dropped. The cross-agent "Approvals" inbox is
      -- this table JOINed to schedules for the agent identity.
      --
      -- tool_input is the JSON draft (email to/subject/body, file path +
      -- content, …). Honest statuses (Principle 21): a discarded action is
      -- never executed; an approved-but-failed execution is 'failed', never
      -- a fake success. FK CASCADE: deleting a run/schedule removes its
      -- approvals; thread link SET NULL so the row survives a thread delete.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS schedule_approvals (
        id            TEXT    PRIMARY KEY,
        schedule_id   TEXT    NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        run_id        TEXT    NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
        thread_id     TEXT    REFERENCES threads(id) ON DELETE SET NULL,
        tool_name     TEXT    NOT NULL,
        tool_input    TEXT    NOT NULL,
        summary       TEXT    NOT NULL,
        -- 'pending' | 'approved' | 'discarded' | 'failed'
        status        TEXT    NOT NULL DEFAULT 'pending',
        result        TEXT,
        error_message TEXT,
        created_at    INTEGER NOT NULL,
        decided_at    INTEGER
      );

      -- Hot path: the inbox (pending, newest first).
      CREATE INDEX IF NOT EXISTS idx_schedule_approvals_pending
        ON schedule_approvals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_schedule_approvals_run
        ON schedule_approvals(run_id);
      CREATE INDEX IF NOT EXISTS idx_schedule_approvals_schedule
        ON schedule_approvals(schedule_id);
    `,
  },
  {
    version: 46,
    name: '046_schedule_delivery',
    sql: `
      -- Delivery preferences (Slice 8e): when a scheduled run notifies the user.
      --   delivery_mode: 'on-activity' (default — drafted/needs-approval/failed/
      --                  produced-a-result; quiet on empty days) | 'every-run' | 'silent'
      --   quiet_on_empty: suppress a nothing-to-report run's notification (no-spam)
      -- Additive + non-destructive; constant DEFAULTs backfill existing rows.
      ALTER TABLE schedules ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'on-activity';
      ALTER TABLE schedules ADD COLUMN quiet_on_empty INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 47,
    name: '047_thread_edits',
    sql: `
      -- ────────────────────────────────────────────────────────────
      -- Edit-by-talking — bind a Builder thread to the agent it edits.
      --
      -- The Builder profile is GENERAL (one 'builder' for everyone). When the
      -- user edits an existing agent, the conversation runs on the general
      -- Builder but is ABOUT a specific agent. This join records WHICH agent
      -- (its slug) a given Builder thread updates, so the edit context is
      -- durable + queryable instead of a one-shot prompt seed: the vertical
      -- re-injects "you are editing <slug>" every turn (client-side, exactly
      -- like the thread_designs pattern from migration 033 — cortex stays a
      -- product-agnostic passthrough, Principle 22).
      --
      -- PRIMARY KEY on thread_id → each thread edits at most one agent.
      -- profile_slug is the registry key, NOT a FK (profiles live on disk, not
      -- in this DB). Indexed so "every edit conversation for agent X" (the
      -- multiple-edits-per-agent history) is a fast lookup. Thread delete
      -- cascades; an agent rename/delete just leaves a harmless stale label.
      -- ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS thread_edits (
        thread_id     TEXT        PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        profile_slug  TEXT        NOT NULL,
        created_at    TEXT        NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_thread_edits_profile
        ON thread_edits(profile_slug);
    `,
  },
  {
    version: 48,
    name: '048_schedule_deliver_to',
    sql: `
      -- Outbound destination for a scheduled run's result (Slice 8 delivery):
      -- "it messages you every morning". NULL/NULL = no channel push (in-app
      -- only — the pre-existing default). channel is a shuttle ChannelKind
      -- ('slack'|'telegram'|'discord'|'whatsapp'|'sms'); target is the
      -- platform-native destination (Slack channel/DM id, Telegram chat id,
      -- phone number…). Two plain columns, not JSON — queryable, and the pair
      -- is validated as a unit at the API boundary (both set or both NULL).
      -- Additive + non-destructive: nullable columns backfill safely.
      ALTER TABLE schedules ADD COLUMN deliver_channel TEXT;
      ALTER TABLE schedules ADD COLUMN deliver_target TEXT;
    `,
  },
  {
    version: 49,
    name: '049_drop_legacy_desktop_tables',
    destructive: {
      reason:
        'Scope-to-core: the legacy desktop verticals (design canvas, edit-by-talking, ' +
        'workspace build-boards) were removed from the gateway — every read/write code ' +
        'path for these tables is deleted, so the data is unreachable dead weight. ' +
        'Rows held desktop-UI state (canvas metadata, thread↔design/edit joins, build ' +
        'boards), never conversation history; threads/messages are untouched.',
    },
    sql: `
      -- Scope-to-core (2026-07-08): the legacy desktop client's verticals
      -- were removed from the gateway (design canvas, edit-by-talking
      -- binding, workspace build-boards). Their tables' entire read/write
      -- code paths are gone, so the tables drop rather than rot. Join
      -- tables first, then parents. workspace_panes is NOT dropped here —
      -- its data-layer code is still present and is removed in a
      -- follow-up migration alongside that sweep.
      DROP TABLE IF EXISTS thread_designs;
      DROP TABLE IF EXISTS designs;
      DROP TABLE IF EXISTS thread_edits;
      DROP TABLE IF EXISTS board_findings;
      DROP TABLE IF EXISTS board_slices;
      DROP TABLE IF EXISTS boards;
    `,
  },
  {
    version: 50,
    name: '050_drop_workspace_panes',
    destructive: {
      reason:
        'Scope-to-core follow-up: the desktop pane substrate (HTTP surface, tool, and ' +
        'data-layer code) is fully removed, so the workspace_panes table is unreachable ' +
        'dead weight. Rows held desktop tab/pane layout state only — never conversation ' +
        'history; threads/messages are untouched.',
    },
    sql: `
      DROP TABLE IF EXISTS workspace_panes;
    `,
  },
  {
    version: 51,
    name: '051_delegated_principals',
    sql: `
      CREATE TABLE delegated_principals (
        token_id         TEXT    PRIMARY KEY,
        delegate_id      TEXT    NOT NULL,
        workspace_id     TEXT    NOT NULL,
        profile_id       TEXT    NOT NULL,
        purpose          TEXT    NOT NULL,
        channel          TEXT,
        operations_json  TEXT    NOT NULL CHECK (json_valid(operations_json)),
        issued_at        INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        revoked_at       INTEGER,
        revoke_reason    TEXT,
        CHECK (expires_at > issued_at),
        CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR revoked_at IS NOT NULL)
      );

      CREATE INDEX idx_delegated_principals_expiry
        ON delegated_principals(expires_at);
      CREATE INDEX idx_delegated_principals_scope
        ON delegated_principals(workspace_id, profile_id, revoked_at);
    `,
  },
  {
    version: 52,
    name: '052_run_idempotency',
    sql: `
      CREATE TABLE run_idempotency (
        id                TEXT    PRIMARY KEY,
        principal_key     TEXT    NOT NULL,
        operation         TEXT    NOT NULL,
        idempotency_key   TEXT    NOT NULL,
        request_salt      TEXT    NOT NULL,
        request_digest    TEXT    NOT NULL,
        state             TEXT    NOT NULL CHECK (state IN ('in_progress', 'completed', 'indeterminate')),
        lease_owner       TEXT    NOT NULL,
        status_code       INTEGER,
        result_json       TEXT    CHECK (result_json IS NULL OR json_valid(result_json)),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        expires_at        INTEGER NOT NULL,
        UNIQUE (principal_key, operation, idempotency_key),
        CHECK ((state = 'completed' AND status_code IS NOT NULL AND result_json IS NOT NULL)
          OR (state != 'completed' AND status_code IS NULL AND result_json IS NULL))
      );

      CREATE INDEX idx_run_idempotency_expiry
        ON run_idempotency(state, expires_at);
    `,
  },
  {
    version: 53,
    name: '053_gateway_runs',
    sql: `
      CREATE TABLE gateway_runs (
        id                  TEXT    PRIMARY KEY,
        thread_id           TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        workspace_id        TEXT,
        profile_id          TEXT    NOT NULL,
        model               TEXT    NOT NULL,
        timeout_ms          INTEGER NOT NULL CHECK (timeout_ms > 0),
        status              TEXT    NOT NULL CHECK (status IN (
          'accepted', 'running', 'waiting', 'cancel_requested',
          'succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate'
        )),
        start_seq           INTEGER NOT NULL CHECK (start_seq >= 0),
        end_seq             INTEGER CHECK (end_seq IS NULL OR end_seq >= start_seq),
        code                TEXT,
        accepted_at         INTEGER NOT NULL,
        started_at          INTEGER,
        updated_at          INTEGER NOT NULL,
        terminal_at         INTEGER,
        cancel_requested_at INTEGER,
        CHECK ((status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate')
          AND terminal_at IS NOT NULL) OR
          (status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate')
          AND terminal_at IS NULL))
      );

      CREATE INDEX idx_gateway_runs_thread
        ON gateway_runs(thread_id, accepted_at DESC);
      CREATE INDEX idx_gateway_runs_status
        ON gateway_runs(status, updated_at);

      ALTER TABLE run_idempotency
        ADD COLUMN run_id TEXT REFERENCES gateway_runs(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX idx_run_idempotency_run
        ON run_idempotency(run_id) WHERE run_id IS NOT NULL;
    `,
  },
  {
    version: 54,
    name: '054_run_permission_requests',
    sql: `
      CREATE TABLE run_permission_requests (
        run_id          TEXT    NOT NULL REFERENCES gateway_runs(id) ON DELETE CASCADE,
        request_id      TEXT    NOT NULL,
        operation_hash  TEXT    NOT NULL,
        tool_name       TEXT    NOT NULL,
        status          TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        requested_at    INTEGER NOT NULL,
        decided_at      INTEGER,
        PRIMARY KEY (run_id, request_id),
        CHECK ((status = 'pending' AND decided_at IS NULL) OR
          (status != 'pending' AND decided_at IS NOT NULL))
      );

      CREATE INDEX idx_run_permission_pending
        ON run_permission_requests(run_id, status, requested_at);
    `,
  },
  {
    version: 55,
    name: '055_profile_candidates',
    sql: `
      CREATE TABLE profile_candidates (
        candidate_id  TEXT    PRIMARY KEY,
        profile_id    TEXT    NOT NULL,
        state         TEXT    NOT NULL CHECK (state IN (
          'placing', 'ready', 'placement_failed', 'cleanup_failed'
        )),
        attempt_id    TEXT,
        file_count    INTEGER NOT NULL CHECK (file_count >= 0),
        total_bytes   INTEGER NOT NULL CHECK (total_bytes >= 0),
        code          TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        CHECK (candidate_id GLOB 'sha256:[0-9a-f]*' AND length(candidate_id) = 71),
        CHECK ((state = 'ready' AND attempt_id IS NULL AND code IS NULL)
          OR (state != 'ready' AND attempt_id IS NOT NULL))
      );

      CREATE INDEX idx_profile_candidates_profile
        ON profile_candidates(profile_id, state, updated_at DESC);
      CREATE INDEX idx_profile_candidates_state
        ON profile_candidates(state, updated_at);
    `,
  },
  {
    version: 56,
    name: '056_profile_candidate_activations',
    sql: `
      CREATE TABLE profile_candidate_activations (
        profile_id    TEXT    PRIMARY KEY,
        candidate_id  TEXT    NOT NULL REFERENCES profile_candidates(candidate_id),
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX idx_profile_candidate_activations_candidate
        ON profile_candidate_activations(candidate_id);

      ALTER TABLE gateway_runs
        ADD COLUMN candidate_id TEXT REFERENCES profile_candidates(candidate_id);
      CREATE INDEX idx_gateway_runs_candidate
        ON gateway_runs(candidate_id, status, updated_at);
    `,
  },
  {
    version: 57,
    name: '057_profile_deployment_state',
    sql: `
      ALTER TABLE profile_candidate_activations
        ADD COLUMN deployment_revision INTEGER NOT NULL DEFAULT 1
          CHECK (deployment_revision > 0);
      ALTER TABLE profile_candidate_activations
        ADD COLUMN routing_state TEXT NOT NULL DEFAULT 'active'
          CHECK (routing_state IN ('active', 'paused'));
      ALTER TABLE profile_candidate_activations
        ADD COLUMN health TEXT NOT NULL DEFAULT 'unknown'
          CHECK (health IN ('unknown', 'starting', 'healthy', 'degraded', 'unhealthy'));
      ALTER TABLE profile_candidate_activations
        ADD COLUMN health_observed_at INTEGER;
    `,
  },
  {
    version: 58,
    name: '058_candidate_retention_evidence',
    sql: `
      CREATE TABLE profile_candidate_activation_history (
        profile_id          TEXT    NOT NULL,
        deployment_revision INTEGER NOT NULL CHECK (deployment_revision > 0),
        candidate_id        TEXT    NOT NULL REFERENCES profile_candidates(candidate_id),
        activated_at        INTEGER NOT NULL,
        PRIMARY KEY (profile_id, deployment_revision)
      );

      INSERT INTO profile_candidate_activation_history (
        profile_id, deployment_revision, candidate_id, activated_at
      )
      SELECT profile_id, deployment_revision, candidate_id, updated_at
      FROM profile_candidate_activations;

      CREATE INDEX idx_candidate_activation_history_candidate
        ON profile_candidate_activation_history(candidate_id, activated_at DESC);

      CREATE TABLE profile_candidate_deletions (
        candidate_id TEXT PRIMARY KEY REFERENCES profile_candidates(candidate_id),
        state        TEXT    NOT NULL CHECK (state IN ('deleting', 'delete_failed', 'deleted')),
        code         TEXT,
        started_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        deleted_at   INTEGER,
        CHECK ((state = 'deleting' AND code IS NULL AND deleted_at IS NULL)
          OR (state = 'delete_failed' AND code IS NOT NULL AND deleted_at IS NULL)
          OR (state = 'deleted' AND code IS NULL AND deleted_at IS NOT NULL))
      );
    `,
  },
  {
    version: 59,
    name: '059_runtime_sources',
    sql: `
      CREATE TABLE runtime_sources (
        source_id               TEXT    PRIMARY KEY,
        workspace_id            TEXT    NOT NULL,
        profile_id              TEXT    NOT NULL,
        kind                    TEXT    NOT NULL CHECK (kind IN (
          'file', 'text', 'visual', 'structured_export',
          'cloud_document', 'connected_snapshot', 'supported_other'
        )),
        label                   TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
        classification          TEXT    NOT NULL CHECK (classification IN (
          'public', 'internal', 'confidential', 'restricted'
        )),
        authority               TEXT    NOT NULL CHECK (authority IN (
          'source_of_record', 'supporting_reference', 'example', 'excluded'
        )),
        audience_policy_ref     TEXT    NOT NULL,
        sensitivity_policy_ref  TEXT    NOT NULL,
        purpose_policy_ref      TEXT    NOT NULL,
        retention_policy_ref    TEXT    NOT NULL,
        freshness_policy_ref    TEXT    NOT NULL,
        revision                INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        current_version_id      TEXT,
        registration_state      TEXT    NOT NULL CHECK (registration_state IN (
          'pending', 'registered', 'rejected'
        )),
        inspection_state        TEXT    NOT NULL CHECK (inspection_state IN (
          'not_started', 'queued', 'inspecting', 'complete', 'partial', 'failed'
        )),
        preparation_state       TEXT    NOT NULL CHECK (preparation_state IN (
          'not_requested', 'queued', 'preparing', 'ready', 'partial', 'failed'
        )),
        access_state            TEXT    NOT NULL CHECK (access_state IN (
          'available', 'denied', 'expired', 'disconnected', 'wrong_identity'
        )),
        freshness_state         TEXT    NOT NULL CHECK (freshness_state IN (
          'fresh', 'aging', 'stale', 'unknown'
        )),
        conflict_state          TEXT    NOT NULL CHECK (conflict_state IN (
          'none', 'suspected', 'confirmed', 'resolved'
        )),
        deletion_state          TEXT    NOT NULL CHECK (deletion_state IN (
          'active', 'frozen', 'deleting', 'partially_deleted', 'deleted'
        )),
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        CHECK (length(source_id) = 36),
        CHECK (updated_at >= created_at)
      );

      CREATE INDEX idx_runtime_sources_scope
        ON runtime_sources(workspace_id, profile_id, created_at DESC, source_id DESC);
    `,
  },
  {
    version: 60,
    name: '060_source_upload_sessions',
    sql: `
      CREATE TABLE source_upload_sessions (
        upload_id             TEXT    PRIMARY KEY,
        source_id             TEXT    NOT NULL REFERENCES runtime_sources(source_id),
        workspace_id          TEXT    NOT NULL,
        profile_id            TEXT    NOT NULL,
        principal_key         TEXT    NOT NULL,
        state                 TEXT    NOT NULL CHECK (state IN (
          'open', 'completing', 'completed', 'expired', 'failed'
        )),
        expected_bytes        INTEGER NOT NULL CHECK (expected_bytes BETWEEN 1 AND 16777216),
        expected_checksum     TEXT    NOT NULL CHECK (
          expected_checksum GLOB 'sha256:[0-9a-f]*' AND length(expected_checksum) = 71
        ),
        declared_media_type   TEXT    NOT NULL CHECK (declared_media_type IN (
          'text/plain', 'application/pdf'
        )),
        filename              TEXT    NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
        durable_offset        INTEGER NOT NULL DEFAULT 0 CHECK (durable_offset >= 0),
        chunk_count           INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count BETWEEN 0 AND 64),
        max_chunk_bytes       INTEGER NOT NULL DEFAULT 1048576 CHECK (max_chunk_bytes = 1048576),
        max_chunks            INTEGER NOT NULL DEFAULT 64 CHECK (max_chunks = 64),
        pending_version_id    TEXT,
        completed_version_id  TEXT,
        code                  TEXT,
        expires_at            INTEGER NOT NULL,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        CHECK (length(upload_id) = 36),
        CHECK (durable_offset <= expected_bytes),
        CHECK (expires_at > created_at),
        CHECK (updated_at >= created_at),
        CHECK ((state = 'open' AND pending_version_id IS NULL AND completed_version_id IS NULL AND code IS NULL)
          OR state != 'open')
      );

      CREATE INDEX idx_source_upload_sessions_scope
        ON source_upload_sessions(workspace_id, profile_id, source_id, created_at DESC);
      CREATE INDEX idx_source_upload_sessions_recovery
        ON source_upload_sessions(state, expires_at, updated_at);
    `,
  },
  {
    version: 61,
    name: '061_source_upload_chunks',
    sql: `
      CREATE TABLE source_upload_chunks (
        upload_id     TEXT    NOT NULL REFERENCES source_upload_sessions(upload_id) ON DELETE CASCADE,
        chunk_index   INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 63),
        start_offset  INTEGER NOT NULL CHECK (start_offset >= 0),
        byte_count    INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 1048576),
        checksum      TEXT    NOT NULL CHECK (
          checksum GLOB 'sha256:[0-9a-f]*' AND length(checksum) = 71
        ),
        accepted_at   INTEGER NOT NULL,
        PRIMARY KEY (upload_id, start_offset),
        UNIQUE (upload_id, chunk_index)
      );
    `,
  },
  {
    version: 62,
    name: '062_source_versions',
    sql: `
      CREATE TABLE source_versions (
        source_version_id   TEXT    PRIMARY KEY,
        source_id           TEXT    NOT NULL REFERENCES runtime_sources(source_id),
        checksum            TEXT    NOT NULL CHECK (
          checksum GLOB 'sha256:[0-9a-f]*' AND length(checksum) = 71
        ),
        verified_media_type TEXT    NOT NULL CHECK (verified_media_type IN (
          'text/plain', 'application/pdf'
        )),
        byte_count          INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 16777216),
        object_key          TEXT    NOT NULL UNIQUE,
        inspection_state    TEXT    NOT NULL DEFAULT 'not_started' CHECK (
          inspection_state IN ('not_started', 'queued', 'inspecting', 'complete', 'partial', 'failed')
        ),
        created_at          INTEGER NOT NULL,
        CHECK (length(source_version_id) = 36)
      );

      CREATE INDEX idx_source_versions_source
        ON source_versions(source_id, created_at DESC, source_version_id DESC);
    `,
  },
  {
    version: 63,
    name: '063_durable_source_jobs',
    sql: `
      CREATE UNIQUE INDEX idx_source_versions_identity_source
        ON source_versions(source_version_id, source_id);
      CREATE UNIQUE INDEX idx_runtime_sources_identity_scope
        ON runtime_sources(source_id, workspace_id, profile_id);

      CREATE TABLE source_jobs (
        job_id                TEXT    PRIMARY KEY,
        workspace_id          TEXT    NOT NULL,
        profile_id            TEXT    NOT NULL,
        source_id             TEXT    NOT NULL,
        source_version_id     TEXT    NOT NULL,
        operation             TEXT    NOT NULL CHECK (operation IN ('inspect_format')),
        state                 TEXT    NOT NULL CHECK (state IN (
          'queued', 'running', 'waiting_for_resource', 'cancel_requested',
          'succeeded', 'partial', 'failed', 'cancelled'
        )),
        attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
        max_attempts          INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
        checkpoint            INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint BETWEEN 0 AND 4),
        claim_token           TEXT,
        claimed_by            TEXT,
        lease_expires_at      INTEGER,
        retry_after           INTEGER,
        cancel_requested_at   INTEGER,
        outcome_code          TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        terminal_at           INTEGER,
        FOREIGN KEY (source_version_id, source_id)
          REFERENCES source_versions(source_version_id, source_id),
        FOREIGN KEY (source_id, workspace_id, profile_id)
          REFERENCES runtime_sources(source_id, workspace_id, profile_id),
        UNIQUE (source_version_id, operation),
        CHECK (length(job_id) = 36),
        CHECK (length(source_id) = 36),
        CHECK (length(source_version_id) = 36),
        CHECK (updated_at >= created_at),
        CHECK (claim_token IS NULL OR length(claim_token) = 36),
        CHECK (claimed_by IS NULL OR (
          length(claimed_by) BETWEEN 1 AND 64
          AND claimed_by NOT GLOB '*[^a-z0-9._-]*'
        )),
        CHECK (outcome_code IS NULL OR (
          length(outcome_code) BETWEEN 1 AND 64
          AND outcome_code NOT GLOB '*[^a-z0-9_]*'
        )),
        CHECK (
          (claim_token IS NULL AND claimed_by IS NULL AND lease_expires_at IS NULL)
          OR
          (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)
        ),
        CHECK (state != 'running' OR claim_token IS NOT NULL),
        CHECK (state NOT IN (
          'queued', 'waiting_for_resource', 'succeeded', 'partial', 'failed', 'cancelled'
        ) OR claim_token IS NULL),
        CHECK ((state = 'waiting_for_resource') = (retry_after IS NOT NULL)),
        CHECK (state != 'cancel_requested' OR cancel_requested_at IS NOT NULL),
        CHECK (state != 'cancelled' OR cancel_requested_at IS NOT NULL),
        CHECK ((state IN ('succeeded', 'partial', 'failed', 'cancelled')) =
          (terminal_at IS NOT NULL)),
        CHECK ((state IN ('succeeded', 'partial', 'failed', 'cancelled')) =
          (outcome_code IS NOT NULL))
      );

      CREATE INDEX idx_source_jobs_scope
        ON source_jobs(workspace_id, profile_id, source_id, created_at DESC, job_id DESC);
      CREATE INDEX idx_source_jobs_claimable
        ON source_jobs(state, retry_after, created_at, job_id);
      CREATE INDEX idx_source_jobs_leases
        ON source_jobs(state, lease_expires_at);
    `,
  },
]
