/**
 * ownware — the umbrella package. One import for the quickstart surface:
 *
 *   import { OwnwareGateway, defineTool } from 'ownware'
 *
 *   const ownware = new OwnwareGateway({ profilesDir: './profiles', port: 4000 })
 *   await ownware.start()
 *
 * This is deliberately a CURATED surface — the pieces the quickstart,
 * the docs, and the adapters use. Power users who need the full engine
 * or kernel API import `@ownware/loom` / `@ownware/cortex` directly.
 */

// ── Serve: the gateway (the whole backend in one class) ──────────────
export { OwnwareGateway } from '@ownware/cortex'
export {
  OfflineTransferError,
  PostgreSqlTransferPreflightError,
  SqliteTransferFindingsError,
  SqliteTransferPreflightError,
  StorageConfigurationError,
  preflightPostgreSqlTransferTarget,
  preflightSqliteTransferSource,
  transferOfflineSqliteToPostgreSql,
} from '@ownware/cortex'
export type {
  GatewayOptions,
  GatewayStorageSelection,
  OfflineSqliteToPostgreSqlTransferOptions,
  OfflineSqliteToPostgreSqlTransferReceipt,
  OfflineTransferErrorCode,
  OfflineTransferProgress,
  PostgreSqlConnectionSource,
  PostgreSqlPoolOptions,
  PostgreSqlStorageOptions,
  PostgreSqlTlsOptions,
  PostgreSqlTransferPreflightErrorCode,
  PostgreSqlTransferRuntimeAuthority,
  PostgreSqlTransferTargetReceipt,
  PostgreSqlTransferTargetState,
  SqliteStorageOptions,
  SqliteTransferFinding,
  SqliteTransferPreflightErrorCode,
  SqliteTransferSourceOptions,
  SqliteTransferSourceReceipt,
  StorageConfigurationErrorCode,
  StoragePlanSummary,
} from '@ownware/cortex'

// ── Build: profiles → running agents ─────────────────────────────────
export { loadProfile, assembleAgent, ProfileRegistry, ProfileSchema } from '@ownware/cortex'

// ── Extend: custom tools ──────────────────────────────────────────────
export { defineTool, createBuiltinTools } from '@ownware/loom'
export type { Tool } from '@ownware/loom'

// ── Run in-process: the engine, for library users ─────────────────────
export { Loom as Engine, Session } from '@ownware/loom'
export type { LoomEvent as EngineEvent } from '@ownware/loom'
export { systemPromptToText } from '@ownware/loom'
