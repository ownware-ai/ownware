export type StorageKind = 'sqlite' | 'postgresql'

export type StorageLifecycleState =
  | 'new'
  | 'initializing'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed'

export interface StorageHealth {
  readonly kind: StorageKind
  readonly state: 'ready' | 'degraded' | 'unavailable'
  readonly schemaVersion: number
  readonly latencyMs?: number
  readonly code?: string
}

export interface StorageTransactionOptions {
  /** Lock/access strategy, not an authorization boundary. */
  readonly mode: 'read' | 'write'
  readonly isolation: 'read-committed' | 'serializable'
  /** Arbitrary callbacks are never replayed by the storage layer. */
  readonly retry: 'never'
}

export interface TransactionStorage<R extends object> {
  readonly repositories: R
  savepoint<T>(fn: (nested: TransactionStorage<R>) => Promise<T>): Promise<T>
}

export interface StorageAdapter<
  R extends object,
  TransactionR extends object = R,
> {
  readonly kind: StorageKind
  readonly lifecycleState: StorageLifecycleState
  readonly repositories: R
  initialize(): Promise<void>
  health(): Promise<StorageHealth>
  transaction<T>(
    options: StorageTransactionOptions,
    fn: (tx: TransactionStorage<TransactionR>) => Promise<T>,
  ): Promise<T>
  close(): Promise<void>
}

export type StorageLifecycleErrorCode =
  | 'initialize_after_close'
  | 'initialize_after_failure'
  | 'initialize_cancelled'
  | 'repository_unavailable'
  | 'root_access_during_transaction'
  | 'transaction_unavailable'
  | 'transaction_options_invalid'
  | 'nested_transaction_requires_savepoint'
  | 'transaction_scope_expired'
  | 'synchronous_close_while_busy'

/** Stable, content-free lifecycle failure safe for logs and support receipts. */
export class StorageLifecycleError extends Error {
  override readonly name = 'StorageLifecycleError'

  constructor(
    readonly code: StorageLifecycleErrorCode,
    readonly kind: StorageKind,
    readonly state: StorageLifecycleState,
  ) {
    super(`Storage lifecycle operation failed (${kind}; ${state}; ${code}).`)
  }
}

export type StorageTransactionErrorCode =
  | 'transaction_busy'
  | 'transaction_begin_failed'
  | 'transaction_commit_failed'
  | 'transaction_rollback_failed'

export type StorageTransactionPhase = 'begin' | 'commit' | 'rollback'

/**
 * Stable, content-free adapter-owned transaction failure.
 *
 * `retryable` describes the failed database operation only. It may be true for
 * serialization or connection loss after the callback ran; `callbackInvoked`
 * reports that distinction. The adapter never replays a callback, and a caller
 * must not replay one unless its own boundary independently proves idempotency.
 */
export class StorageTransactionError extends Error {
  override readonly name = 'StorageTransactionError'

  constructor(
    readonly code: StorageTransactionErrorCode,
    readonly kind: StorageKind,
    readonly phase: StorageTransactionPhase,
    readonly retryable: boolean,
    readonly callbackInvoked: boolean,
  ) {
    super(
      `Storage transaction failed (${kind}; ${phase}; ${code}; ` +
        `retryable=${String(retryable)}; callbackInvoked=${String(callbackInvoked)}).`,
    )
  }
}

export type StorageRepositoryDomain =
  | 'threads'
  | 'messages'
  | 'usage'
  | 'usage_evidence'
  | 'plugins'
  | 'events'
  | 'credentials'
  | 'credential_audit'
  | 'credential_spend'
  | 'credential_migrations'
  | 'principals'
  | 'thread_bindings'
  | 'runs'
  | 'idempotency'
  | 'access_grants'
  | 'oauth_refresh'
  | 'codex_thread_references'
  | 'sources'
  | 'source_uploads'
  | 'source_jobs'
  | 'source_data_views'
  | 'source_deletions'
  | 'connector_connections'
  | 'channel_jobs'
  | 'schedules'
  | 'schedule_approvals'
  | 'tasks'
  | 'memories'
  | 'memory_proposals'
  | 'user_identity'
  | 'profile_candidates'
  | 'teams'
  | 'workspaces'
  | 'mcp_servers'
  | 'local_profile'
  | 'user_settings'
  | 'profile_metadata'
  | 'app_state'
  | 'audit_log'
  | 'gateway_diagnostics'
export type StorageRepositoryErrorCode = 'read_failed' | 'write_failed'

/**
 * Stable, content-free repository failure safe to cross the gateway boundary.
 *
 * Driver messages are deliberately discarded. They can contain SQL,
 * filesystem paths, server addresses or customer values and must never become
 * an HTTP/SSE error, log entry or support receipt.
 */
export class StorageRepositoryError extends Error {
  override readonly name = 'StorageRepositoryError'

  constructor(
    readonly code: StorageRepositoryErrorCode,
    readonly kind: StorageKind,
    readonly domain: StorageRepositoryDomain,
    readonly operation: string,
    readonly retryable: boolean,
  ) {
    super(
      `Storage repository operation failed (${kind}; ${domain}; ${operation}; ` +
        `${code}; retryable=${String(retryable)}).`,
    )
  }
}

export type PostgreSqlStorageErrorCode =
  | 'driver_missing'
  | 'driver_invalid'
  | 'ca_unreadable'
  | 'connection_failed'
  | 'connection_dropped'
  | 'server_version_unsupported'
  | 'database_mismatch'
  | 'tls_required'
  | 'tls_unexpected'
  | 'migration_lock_timeout'
  | 'migration_permission_denied'
  | 'schema_owner_mismatch'
  | 'schema_unrecognized'
  | 'schema_history_diverged'
  | 'schema_version_newer'
  | 'schema_manifest_mismatch'
  | 'baseline_failed'
  | 'migration_failed'
  | 'runtime_permission_denied'
  | 'shutdown_timeout'

export type PostgreSqlStoragePhase =
  | 'driver'
  | 'configuration'
  | 'migration'
  | 'runtime'
  | 'health'
  | 'shutdown'

/**
 * Stable PostgreSQL diagnostic. Driver messages and connection material are
 * deliberately discarded because either may contain SQL, hostnames or secrets.
 */
export class PostgreSqlStorageError extends Error {
  override readonly name = 'PostgreSqlStorageError'

  constructor(
    readonly code: PostgreSqlStorageErrorCode,
    readonly phase: PostgreSqlStoragePhase,
    readonly retryable: boolean,
  ) {
    super(
      `PostgreSQL storage operation failed (${phase}; ${code}; ` +
        `retryable=${String(retryable)}).`,
    )
  }
}
