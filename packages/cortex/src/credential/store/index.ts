/**
 * Credential store dispatcher.
 *
 * Handlers, resolver, and session-runner import a single
 * `CredentialStore` interface; the dispatcher hides which backend
 * served a row. Today there is one backend (`DbCredentialBackend`);
 * a future cloud-sync tier can add a second without consumers caring.
 *
 * The dispatcher also owns boot-migration sequencing — see
 * `runCredentialBootMigrations` below.
 */

import type Database from 'better-sqlite3'
import { CredentialVault } from '../../connector/credentials/vault.js'
import {
  importFileVaultIntoCredentials,
  type FileVaultImportResult,
} from '../migrations/import-file-vault.js'
import {
  importProviderKeysIntoCredentials,
  type ProviderKeysImportResult,
} from '../migrations/import-provider-keys.js'
import { DbCredentialBackend } from './db-backend.js'
import type { CredentialBackend } from './types.js'

// ---------------------------------------------------------------------------
// CredentialStore — the consumer-facing surface
// ---------------------------------------------------------------------------

/**
 * Wire shape every handler / resolver imports. Identical to
 * `CredentialBackend` today so the dispatcher is a pass-through. The
 * separate name exists so the future multi-backend dispatcher can
 * introduce dispatcher-only methods (e.g. `which(id)` to ask "which
 * backend served this row") without widening the per-backend
 * interface.
 */
export type CredentialStore = CredentialBackend

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Build a `CredentialStore` over the given DB handle.
 *
 * The dispatcher does NOT run migrations here — boot sequencing is
 * the gateway's job and lives in `runCredentialBootMigrations` so
 * the order is explicit at the call site. Tests that want a clean
 * store can construct one directly via `new DbCredentialBackend(db)`
 * and skip the migration pass entirely.
 */
export function createCredentialStore(db: Database.Database): CredentialStore {
  return new DbCredentialBackend(db)
}

// ---------------------------------------------------------------------------
// Boot migrations
// ---------------------------------------------------------------------------

export interface CredentialBootMigrationResult {
  readonly providerKeys: ProviderKeysImportResult
  readonly fileVault: FileVaultImportResult
}

export interface CredentialBootMigrationOptions {
  /** Override the vault implementation (tests pass a temp-dir vault). */
  readonly vault?: CredentialVault
  /** Force every migration to re-run regardless of its app_state flag. */
  readonly forceRun?: boolean
  /** Whether to delete imported .json files. Default: true. */
  readonly deleteAfterImport?: boolean
  /** Optional log sink. Default: no-op. Production passes `console.log`. */
  readonly log?: (message: string) => void
}

/**
 * Run every legacy → unified credential importer in canonical order:
 *
 *   1. `provider_keys` table (legacy LLM-key store, scrypt-derived
 *      cipher with hostname/user portability bug) → unified table.
 *   2. `~/.ownware/credentials/*.json` file vault (legacy MCP-server
 *      env bundles) → unified table.
 *
 * Each importer is idempotent via its own `app_state` flag; subsequent
 * boots short-circuit and return `ran: false`. Order matters only for
 * the log sink — provider keys log line surfaces before the file-vault
 * line, matching the migration history docs.
 */
export async function runCredentialBootMigrations(
  db: Database.Database,
  store: CredentialStore,
  options: CredentialBootMigrationOptions = {},
): Promise<CredentialBootMigrationResult> {
  const log = options.log ?? (() => {})
  const forceRun = options.forceRun ?? false
  const providerKeys = await importProviderKeysIntoCredentials(db, store, {
    forceRun,
    log,
  })
  const fileVault = await importFileVaultIntoCredentials(db, store, {
    vault: options.vault,
    forceRun,
    deleteAfterImport: options.deleteAfterImport ?? true,
    log,
  })
  return { providerKeys, fileVault }
}
