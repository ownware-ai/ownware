/**
 * ConnectorConnectionsStore — source-agnostic OAuth/API-key connection state.
 *
 * Phase 2a (Connector Foundation) lands this store. Composio, webhook-MCP,
 * Pipedream, Zapier, and every future external OAuth source uses the same
 * row shape and the same `pending → ready | failed | expired` state machine.
 *
 * The store is a pure module of typed functions over a `Database.Database`
 * handle. It performs no I/O beyond the given handle, owns no singletons,
 * and is safe to instantiate per-test against a fresh temp db. All rows
 * are Zod-validated at the SQLite boundary so a rogue write (or a future
 * migration bug) is caught immediately.
 *
 * Production wiring:
 *   const store = new ConnectorConnectionsStore(state.rawDbHandle)
 *
 * Test wiring:
 *   const store = new ConnectorConnectionsStore(new Database(':memory:'))
 *   runMigrations(store.db, MIGRATIONS) // or use CortexDatabase
 */

import type { Database } from 'better-sqlite3'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Status enum + Zod
// ---------------------------------------------------------------------------

/**
 * Terminal vs non-terminal:
 *   - `pending` — initiated, not yet complete (polling / user in OAuth flow)
 *   - `ready`   — complete and usable
 *   - `failed`  — terminal failure (user rejected, network blocked, vendor
 *                 returned 4xx, etc.) — carries `error_reason`
 *   - `expired` — pending row that did not complete before `expires_at`
 *                 (e.g. user closed the OAuth window; gateway restarted
 *                 before completion)
 */
export const ConnectionStatusSchema = z.enum([
  'pending',
  'ready',
  'failed',
  'expired',
])
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>

/** Matches the `connector_connections.source` column. Free-form string
 * so future vendors can register without a schema change. */
export const ConnectionSourceSchema = z.string().min(1).max(64)

// ---------------------------------------------------------------------------
// Row schema
// ---------------------------------------------------------------------------

/**
 * Public row shape returned by every read helper. `metadata` is parsed
 * from `metadata_json` — the raw JSON never escapes the store.
 */
export const ConnectionRowSchema = z.object({
  connectionId: z.string().min(1),
  connectorId: z.string().min(1),
  source: ConnectionSourceSchema,
  // entity_id is NOT NULL at the schema layer (migration 019). The runtime
  // identity comes from InstallIdentity — there is no "null entity" in v1.
  entityId: z.string().min(1),
  status: ConnectionStatusSchema,
  initiatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  lastPolledAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  errorReason: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  /**
   * Phase 2b.1: vendor auth-configuration id used when the link was
   * created (Composio writes its `auth_config_id` here). Nullable because
   * (a) 2a-era rows and non-Composio sources do not have this concept,
   * and (b) the column was added in migration 009 after the initial
   * 2a rollout.
   */
  authConfigId: z.string().min(1).nullable(),
  /**
   * Vendor-frozen pointer to this connection (e.g. Composio's
   * `connected_account_id`). Set at connect-completion (markReady)
   * by the source-specific listener. Used by `ConnectorIdentityResolver`
   * at execute-time so we never derive identity from current local
   * state. Nullable because MCP / custom_mcp / builtin don't have this
   * concept, and pre-021 Composio rows had it buried in metadata —
   * migration 021 backfills those into this column.
   */
  vendorAccountId: z.string().min(1).nullable(),
  /**
   * The user-identity string we sent to the vendor at connect-time
   * (e.g. Composio's `user_id`). Frozen — once recorded, never changes.
   * Defensive: if a vendor ever requires this field on refresh / execute,
   * we send the value frozen at connect-time, NOT the live entity_id.
   * The entity_id may have migrated between connect and execute (it did
   * for migration 019); vendor_user_id is what the vendor's record
   * actually says.
   *
   * Null on legacy rows (pre-021) because we didn't capture it then.
   * The resolver handles null cleanly: for Composio, vendor_account_id
   * alone is sufficient.
   */
  vendorUserId: z.string().min(1).nullable(),
  /**
   * Unix-ms timestamp of the most recent successful reconciliation
   * against the source of truth. Distinct from `lastPolledAt` which
   * fires on every tick regardless of outcome — `lastVerifiedAt` is
   * set ONLY when the row's status was confirmed healthy by the
   * vendor (Composio `listConnectedAccounts` returned ACTIVE; MCP
   * tools/list round-tripped). Null for rows that have never been
   * verified (fresh inserts, pre-migration-028 rows, terminal rows).
   *
   * Read by the registry when projecting a wire `Connector` so the client
   * can show "Last checked Xm ago" beneath `stale` rows.
   *
   * Added migration 028 (2026-05-16, F4.c-1).
   */
  lastVerifiedAt: z.number().int().nonnegative().nullable(),
})
export type ConnectionRow = z.infer<typeof ConnectionRowSchema>

// ---------------------------------------------------------------------------
// DB row (raw) → domain row
// ---------------------------------------------------------------------------

interface DbRow {
  connection_id: string
  connector_id: string
  source: string
  entity_id: string
  status: string
  initiated_at: number
  completed_at: number | null
  last_polled_at: number | null
  expires_at: number | null
  error_reason: string | null
  metadata_json: string | null
  auth_config_id: string | null
  vendor_account_id: string | null
  vendor_user_id: string | null
  last_verified_at: number | null
}

function mapRow(r: DbRow): ConnectionRow {
  let metadata: Record<string, unknown> | null = null
  if (r.metadata_json !== null) {
    try {
      const parsed: unknown = JSON.parse(r.metadata_json)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed row — treat metadata as null. Never throws to the caller;
      // the caller either writes fresh metadata or ignores.
      metadata = null
    }
  }
  return ConnectionRowSchema.parse({
    connectionId: r.connection_id,
    connectorId: r.connector_id,
    source: r.source,
    entityId: r.entity_id,
    status: r.status,
    initiatedAt: r.initiated_at,
    completedAt: r.completed_at,
    lastPolledAt: r.last_polled_at,
    expiresAt: r.expires_at,
    errorReason: r.error_reason,
    metadata,
    authConfigId: r.auth_config_id,
    vendorAccountId: r.vendor_account_id,
    vendorUserId: r.vendor_user_id,
    lastVerifiedAt: r.last_verified_at,
  })
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const UpsertPendingInputSchema = z.object({
  connectionId: z.string().min(1),
  connectorId: z.string().min(1),
  source: ConnectionSourceSchema,
  // Required and non-empty. Callers must resolve via InstallIdentity.
  entityId: z.string().min(1),
  /** Unix ms. Defaults to `Date.now()` when omitted. */
  initiatedAt: z.number().int().nonnegative().optional(),
  /** Unix ms. When set, the poller/`expireStaleOnBoot()` will expire the
   * row after this deadline passes without reaching `ready`/`failed`. */
  expiresAt: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Phase 2b.1: optional vendor auth-config id (Composio `auth_config_id`). */
  authConfigId: z.string().min(1).optional(),
  /**
   * Identity strings frozen at connect-time. The connect handler knows
   * what it sent to the vendor (`vendorUserId`) and what the vendor
   * returned (`vendorAccountId`). Recording both on the row means the
   * resolver at execute-time can send vendor-frozen values without
   * trusting our local entity_id, which can migrate.
   */
  vendorAccountId: z.string().min(1).optional(),
  vendorUserId: z.string().min(1).optional(),
})
export type UpsertPendingInput = z.infer<typeof UpsertPendingInputSchema>

export const MarkReadyInputSchema = z.object({
  connectionId: z.string().min(1),
  /** Unix ms. Defaults to `Date.now()`. */
  completedAt: z.number().int().nonnegative().optional(),
  /** Merged (shallow) with existing metadata. Caller passes vendor-supplied
   * completion payload (tokens, final scopes, etc.). */
  metadata: z.record(z.unknown()).optional(),
  /**
   * Vendor identity captured at OAuth completion. The listener / resync
   * passes whatever the vendor's "connected account" record carries —
   * for Composio that's `account.id` (→ vendorAccountId) and the
   * `account.user_id` echoed back (→ vendorUserId).
   *
   * If a markReady is called without these (legacy code path), the
   * fields stay null and the resolver throws on execute — better than
   * silently falling back to entity_id, which is the bug we're killing.
   */
  vendorAccountId: z.string().min(1).optional(),
  vendorUserId: z.string().min(1).optional(),
})
export type MarkReadyInput = z.infer<typeof MarkReadyInputSchema>

export const MarkFailedInputSchema = z.object({
  connectionId: z.string().min(1),
  reason: z.string().min(1),
  completedAt: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type MarkFailedInput = z.infer<typeof MarkFailedInputSchema>

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ConnectorConnectionsStore {
  constructor(private readonly db: Database) {}

  /**
   * Insert (or idempotently update) a `pending` row.
   *
   * Idempotency: if a row with `connectionId` already exists in
   * `pending`, the call is a no-op (metadata is replaced only if the
   * caller passes one). Callers that want to start a FRESH attempt
   * must pick a new `connectionId`.
   *
   * Conflict with the partial-unique index: if another `pending` or
   * `ready` row exists for the same (connector_id, source, entity_id)
   * with a DIFFERENT connection_id, the insert throws
   * `SQLITE_CONSTRAINT_UNIQUE`. Callers translate that into a
   * `ConnectorAlreadyConnectingError` or similar.
   */
  upsertPending(input: UpsertPendingInput): ConnectionRow {
    const parsed = UpsertPendingInputSchema.parse(input)
    const now = parsed.initiatedAt ?? Date.now()
    const metadataJson = parsed.metadata ? JSON.stringify(parsed.metadata) : null

    // Path A: same-connection-id idempotency. The caller may dispatch
    // twice for the same Composio link (e.g. retry network blip after
    // createConnectionLink succeeded). Update in place, don't insert.
    const existing = this.findByConnectionId(parsed.connectionId)
    if (existing && existing.status === 'pending') {
      if (
        parsed.metadata !== undefined
        || parsed.authConfigId !== undefined
        || parsed.vendorAccountId !== undefined
        || parsed.vendorUserId !== undefined
      ) {
        this.db.prepare(
          `UPDATE connector_connections
             SET metadata_json     = COALESCE(?, metadata_json),
                 expires_at        = COALESCE(?, expires_at),
                 auth_config_id    = COALESCE(?, auth_config_id),
                 vendor_account_id = COALESCE(?, vendor_account_id),
                 vendor_user_id    = COALESCE(?, vendor_user_id)
           WHERE connection_id = ?`,
        ).run(
          metadataJson,
          parsed.expiresAt ?? null,
          parsed.authConfigId ?? null,
          parsed.vendorAccountId ?? null,
          parsed.vendorUserId ?? null,
          parsed.connectionId,
        )
      }
      return this.findByConnectionId(parsed.connectionId)!
    }
    if (existing && existing.status === 'ready') {
      // Already fully connected — no-op. The client's UI shouldn't hit this
      // path, but if it does we preserve the ready row.
      return existing
    }

    // Path B: tuple-level retry. The unique index
    // `idx_connector_connections_one_live` is PARTIAL — it covers
    // `(connector_id, source, entity_id)` but only WHERE
    // `status IN ('pending','ready')`. So multiple `failed` /
    // `expired` rows for the same tuple are legal and harmless; only
    // a live (pending|ready) row collides with a new pending INSERT.
    //
    // The lookup below must therefore filter to JUST the conflicting
    // statuses — otherwise the SELECT could pick an innocent
    // `expired` row, DELETE it, and then the INSERT would still fail
    // on the actual `pending` row that's blocking. This is the exact
    // bug that surfaced in the user's DB on 2026-05-26 (one expired
    // + one pending row for the same tuple).
    //
    // Resolution: SELECT only the live row. If it's `ready` → return
    // it (never destroy a working connection). If `pending` → DELETE +
    // INSERT inside a transaction so a concurrent insert can't slip
    // between. Old `expired` / `failed` rows are left in place as
    // history; they don't conflict and pruning them is the
    // retention job's responsibility, not this hot path's.
    const tx = this.db.transaction((): { reusedReady: ConnectionRow | null } => {
      const live = this.db.prepare(
        `SELECT connection_id, status FROM connector_connections
          WHERE connector_id = ? AND source = ? AND entity_id = ?
            AND status IN ('pending','ready')
          LIMIT 1`,
      ).get(parsed.connectorId, parsed.source, parsed.entityId) as
        { connection_id: string; status: string } | undefined

      if (live && live.status === 'ready') {
        return { reusedReady: this.findByConnectionId(live.connection_id) }
      }
      if (live) {
        // Replace the stuck pending row. The new INSERT below uses a
        // different connection_id (Composio generated a fresh one),
        // so the partial unique constraint needs the old pending row
        // gone before we insert. DELETE + INSERT is wrapped in this
        // transaction so no other writer can sneak a conflicting row
        // in between.
        this.db.prepare(
          `DELETE FROM connector_connections WHERE connection_id = ?`,
        ).run(live.connection_id)
      }
      this.db.prepare(
        `INSERT INTO connector_connections
           (connection_id, connector_id, source, entity_id, status,
            initiated_at, completed_at, last_polled_at, expires_at,
            error_reason, metadata_json, auth_config_id,
            vendor_account_id, vendor_user_id)
         VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        parsed.connectionId,
        parsed.connectorId,
        parsed.source,
        parsed.entityId,
        now,
        parsed.expiresAt ?? null,
        metadataJson,
        parsed.authConfigId ?? null,
        parsed.vendorAccountId ?? null,
        parsed.vendorUserId ?? null,
      )
      return { reusedReady: null }
    })
    const result = tx()
    if (result.reusedReady !== null) return result.reusedReady
    return this.findByConnectionId(parsed.connectionId)!
  }

  /**
   * Transition a pending/ready row to `ready`. Idempotent on an
   * already-`ready` row (timestamps are preserved, metadata is merged
   * shallowly if supplied).
   */
  markReady(input: MarkReadyInput): ConnectionRow {
    const parsed = MarkReadyInputSchema.parse(input)
    const existing = this.findByConnectionId(parsed.connectionId)
    if (!existing) {
      throw new Error(`Connection not found: ${parsed.connectionId}`)
    }

    const mergedMetadata = parsed.metadata
      ? { ...(existing.metadata ?? {}), ...parsed.metadata }
      : existing.metadata
    const metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : null

    if (existing.status === 'ready') {
      // Already ready — only update metadata + vendor identity if the
      // caller supplied any. Preserves completedAt for audit. Vendor
      // identity COALESCE means resync re-running on an already-ready
      // row can fill in a missing vendorAccountId without overwriting
      // an existing one. The architectural rule: vendor identity is
      // append-only-if-null; never replaces a known value.
      const wantsUpdate =
        parsed.metadata !== undefined
        || parsed.vendorAccountId !== undefined
        || parsed.vendorUserId !== undefined
      if (wantsUpdate) {
        this.db.prepare(
          `UPDATE connector_connections
              SET metadata_json     = COALESCE(?, metadata_json),
                  vendor_account_id = COALESCE(vendor_account_id, ?),
                  vendor_user_id    = COALESCE(vendor_user_id, ?)
            WHERE connection_id = ?`,
        ).run(
          parsed.metadata ? metadataJson : null,
          parsed.vendorAccountId ?? null,
          parsed.vendorUserId ?? null,
          parsed.connectionId,
        )
      }
      return this.findByConnectionId(parsed.connectionId)!
    }

    const now = parsed.completedAt ?? Date.now()
    // Vendor identity is append-only-if-null: preserve any value
    // already on the row, only fill when the column is currently null.
    // Connect handler writes vendor identity at upsertPending time;
    // the later markReady from the listener typically echoes the same
    // value back. We keep the EARLIER (connect-time) value to honour
    // the rule that vendor-frozen identity is recorded once and never
    // overwritten.
    this.db.prepare(
      `UPDATE connector_connections
          SET status = 'ready',
              completed_at = ?,
              error_reason = NULL,
              metadata_json = ?,
              vendor_account_id = COALESCE(vendor_account_id, ?),
              vendor_user_id    = COALESCE(vendor_user_id, ?)
        WHERE connection_id = ?`,
    ).run(
      now,
      metadataJson,
      parsed.vendorAccountId ?? null,
      parsed.vendorUserId ?? null,
      parsed.connectionId,
    )

    return this.findByConnectionId(parsed.connectionId)!
  }

  /** Transition to terminal `failed` with a human-readable reason. */
  markFailed(input: MarkFailedInput): ConnectionRow {
    const parsed = MarkFailedInputSchema.parse(input)
    const existing = this.findByConnectionId(parsed.connectionId)
    if (!existing) {
      throw new Error(`Connection not found: ${parsed.connectionId}`)
    }

    const mergedMetadata = parsed.metadata
      ? { ...(existing.metadata ?? {}), ...parsed.metadata }
      : existing.metadata
    const metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : null
    const now = parsed.completedAt ?? Date.now()

    this.db.prepare(
      `UPDATE connector_connections
          SET status = 'failed',
              completed_at = ?,
              error_reason = ?,
              metadata_json = ?
        WHERE connection_id = ?`,
    ).run(now, parsed.reason, metadataJson, parsed.connectionId)

    return this.findByConnectionId(parsed.connectionId)!
  }

  /**
   * Transition the given connection to `expired` with a fixed reason.
   * Used by the poller when `expires_at` passes mid-flight.
   */
  markExpired(connectionId: string, reason?: string): ConnectionRow | null {
    const existing = this.findByConnectionId(connectionId)
    if (!existing) return null
    if (existing.status !== 'pending') return existing

    this.db.prepare(
      `UPDATE connector_connections
          SET status = 'expired',
              completed_at = ?,
              error_reason = ?
        WHERE connection_id = ?`,
    ).run(
      Date.now(),
      reason ?? 'Connection attempt timed out.',
      connectionId,
    )
    return this.findByConnectionId(connectionId)
  }

  /**
   * Transition a `pending` or `ready` connection to `expired` as the
   * result of an explicit user-initiated disconnect. The vendor-side
   * revocation (Composio's `DELETE /connected_accounts/:id`) is the
   * caller's responsibility — this method only records the local
   * state change. Already-terminal rows (`expired` / `failed`) are
   * no-ops so replaying a disconnect is safe.
   */
  markRevoked(connectionId: string, reason: string): ConnectionRow | null {
    const existing = this.findByConnectionId(connectionId)
    if (!existing) return null
    if (existing.status === 'expired' || existing.status === 'failed') {
      return existing
    }

    this.db.prepare(
      `UPDATE connector_connections
          SET status = 'expired',
              completed_at = ?,
              error_reason = ?
        WHERE connection_id = ?`,
    ).run(Date.now(), reason, connectionId)
    return this.findByConnectionId(connectionId)
  }

  /** Record that the poller just ran against this connection. */
  touchPolled(connectionId: string, at: number = Date.now()): void {
    this.db.prepare(
      `UPDATE connector_connections SET last_polled_at = ? WHERE connection_id = ?`,
    ).run(at, connectionId)
  }

  /**
   * Record that the reconciler confirmed this connection is healthy
   * (vendor reports ACTIVE / MCP transport responded). Distinct from
   * `touchPolled` which fires on every tick. Caller invokes ONLY after
   * a successful verification.
   *
   * Added 2026-05-16 (F4.c-1, status taxonomy migration).
   */
  touchVerified(connectionId: string, at: number = Date.now()): void {
    this.db.prepare(
      `UPDATE connector_connections SET last_verified_at = ? WHERE connection_id = ?`,
    ).run(at, connectionId)
  }

  /** Lookup by primary key. */
  findByConnectionId(connectionId: string): ConnectionRow | null {
    const row = this.db.prepare(
      `SELECT * FROM connector_connections WHERE connection_id = ?`,
    ).get(connectionId) as DbRow | undefined
    return row ? mapRow(row) : null
  }

  /**
   * Every row for a (source, status) tuple, optionally scoped to an
   * entity. Used by the composio tool adapter's boot scan to warm
   * every ready connection's manifest cache. Callers that need the
   * "pending OR ready" union use `findActive` per connectorId.
   */
  listActiveByStatus(
    source: string,
    status: 'pending' | 'ready',
    entityId: string,
  ): ConnectionRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM connector_connections
        WHERE source = ? AND status = ? AND entity_id = ?
        ORDER BY initiated_at ASC`,
    ).all(source, status, entityId) as DbRow[]
    return rows.map(mapRow)
  }

  /**
   * Count rows whose `entity_id` does not match the install identity.
   *
   * Defense-in-depth: the schema layer (migration 019) enforces
   * `entity_id NOT NULL`, and every code path now routes writes through
   * `InstallIdentity`. If a row ever shows up under a different identity
   * — for example because the operator changed `OWNWARE_COMPOSIO_USER_ID`
   * after rows were written under the previous value — the user would
   * silently see "not connected" again. The boot self-check logs the
   * count so the regression is loud.
   */
  countForeignEntities(installEntityId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n
         FROM connector_connections
        WHERE entity_id <> ?`,
    ).get(installEntityId) as { n: number } | undefined
    return row?.n ?? 0
  }

  /** Every `pending` row, oldest first. Used by boot-time expiry scan. */
  findPending(): ConnectionRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM connector_connections
        WHERE status = 'pending'
        ORDER BY initiated_at ASC`,
    ).all() as DbRow[]
    return rows.map(mapRow)
  }

  /**
   * Find the currently-live row (pending or ready) for a
   * (connector_id, source, entity_id). The partial-unique index
   * guarantees at most one such row.
   *
   * `entityId` is required and non-empty. Callers resolve it via
   * `InstallIdentity` at the gateway boundary — there is no "null
   * entity" in v1.
   */
  findActive(
    connectorId: string,
    source: string,
    entityId: string,
  ): ConnectionRow | null {
    const row = this.db.prepare(
      `SELECT * FROM connector_connections
        WHERE connector_id = ? AND source = ? AND entity_id = ?
          AND status IN ('pending','ready')
        LIMIT 1`,
    ).get(connectorId, source, entityId) as DbRow | undefined
    return row ? mapRow(row) : null
  }

  /**
   * Look up the most recent `last_verified_at` timestamp for a
   * (connector_id, source) pair, regardless of entity_id or status.
   *
   * Used by the connector registry's wire projection: when a profile
   * surfaces an MCP / Composio connector, the registry projects
   * `lastVerifiedAt` onto the wire so the client can show "Last checked
   * Xm ago" beneath `stale` connectors. The lookup is scoped to
   * (connectorId, source) only — the entity dimension is hidden
   * from the wire because the client never branches on it.
   *
   * Returns `null` when no row exists or every row's
   * `last_verified_at` is null (fresh insert, pre-migration-028).
   * The registry treats `null` as "omit the field on the wire."
   *
   * Added 2026-05-17 (F4.c-2, registry plumbing).
   */
  findLastVerifiedAt(connectorId: string, source: string): number | null {
    const row = this.db.prepare(
      `SELECT MAX(last_verified_at) AS at
         FROM connector_connections
        WHERE connector_id = ? AND source = ?`,
    ).get(connectorId, source) as { at: number | null } | undefined
    return row?.at ?? null
  }

  /**
   * Boot-time sweep: any `pending` row whose `expires_at` is before
   * `now` becomes `expired`. Returns the number of rows updated.
   *
   * This is the v1-accepted honest trade-off for not having cross-
   * restart poll persistence: if the gateway restarts while an OAuth
   * attempt is in flight, the row was un-polled during the downtime
   * and the user must retry. Marking `expired` with an actionable
   * reason gives them a clear next step instead of a mystery "stuck"
   * connection.
   */
  expireStaleOnBoot(now: number = Date.now()): number {
    const result = this.db.prepare(
      `UPDATE connector_connections
          SET status = 'expired',
              completed_at = ?,
              error_reason = ?
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at < ?`,
    ).run(
      now,
      'Connection attempt did not complete before gateway restarted. Please retry.',
      now,
    )
    return result.changes
  }
}
