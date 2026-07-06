/**
 * Evergreen import: legacy file vault (`~/.ownware/credentials/*.json`)
 * → unified `credentials` table (board: credentials-unification — C05).
 *
 * The pre-unification file vault stores one encrypted JSON file per
 * connector, with a single payload of `{ env: Record<string, string> }`
 * (one or more env-var assignments). Each env-var entry becomes one
 * credential row in the unified table.
 *
 * Synthesised metadata:
 *   - `category`     = `'mcp-server'`
 *   - `authType`     = `'api-key'`
 *   - `trust`        = `'medium'` (the schema default)
 *   - `source`       = `'mcp-config'`
 *   - `forConnector` = the connector id (the file's basename)
 *   - `variableName` = the env-var key in the bundle
 *   - `name`         = `"<connectorId>: <variableName>"` — distinct
 *     per row so the Settings list shows them grouped under their
 *     connector with a clear sub-label.
 *
 * Skipped:
 *   - Files whose id matches the per-thread runtime pattern
 *     `runtime.<threadId>.<varName>`. Those are the 283 stale
 *     duplicates mentioned in the board; they get purged separately
 *     by C42, NOT migrated.
 *   - Bundles whose value is empty after decrypt (corrupt file).
 *
 * After every env-var entry of a file imports successfully, the
 * underlying `.json` is deleted via `vault.delete(connectorId)`. If
 * any entry fails, the file is left in place so re-running the
 * importer (after the operator fixes the cause) can retry.
 *
 * Idempotency:
 *   - Runs on every boot. Per-row dedupe via the existing
 *     `(forConnector, variableName)` Set means already-imported pairs
 *     are skipped, so re-running is cheap and lossless.
 *   - The legacy `file_vault_imported_v1` flag in `app_state` is no
 *     longer consulted. It was the cause of customer leaks: the file
 *     vault is still a write path elsewhere in the codebase (see
 *     `connector/registry.ts`, `gateway/handlers/mcp.ts`,
 *     `connector-runtime-setup.ts`), so files added AFTER the first
 *     boot were orphaned forever. Running every boot catches them.
 *     The flag is preserved on existing installs as a no-op for
 *     historical traceability — once D-E (read+write switch to SQL)
 *     lands and the file vault stops gaining new entries, the flag
 *     row can be dropped.
 *   - `forceRun` parameter retained for tests that want to assert
 *     "what happens on the very first run after a fresh install".
 */

import type Database from 'better-sqlite3'
import {
  CredentialVault,
  credentialVault as defaultVault,
} from '../../connector/credentials/vault.js'
import { parseRuntimeCredentialId } from '../runtime.js'
import type { CredentialBackend } from '../store/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FILE_VAULT_IMPORTED_FLAG = 'file_vault_imported_v1'

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface FileVaultImportResult {
  /** True if the importer ran (flag was unset or forceRun was true). */
  readonly ran: boolean
  /** Per-connector summary of what happened. */
  readonly perConnector: ReadonlyArray<{
    readonly connectorId: string
    readonly importedVars: readonly string[]
    readonly skippedVars: readonly string[]
    readonly errors: readonly string[]
    /** True if the .json file was deleted after a fully-successful import. */
    readonly fileDeleted: boolean
  }>
  /** Connector ids that matched the runtime.* pattern and were skipped entirely. */
  readonly skippedRuntime: readonly string[]
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ImportFileVaultOptions {
  /** Override the vault implementation (tests pass a temp-dir vault). */
  readonly vault?: CredentialVault
  /** Force the import to run even when the flag is set. Tests only. */
  readonly forceRun?: boolean
  /**
   * If false, leave the .json files on disk after a successful import.
   * Defaults to true (D8 — file vault is being deleted post-migration).
   * Tests use false so subsequent assertions can read the file state.
   */
  readonly deleteAfterImport?: boolean
  /** Optional log sink — defaults to no-op. */
  readonly log?: (message: string) => void
}

export async function importFileVaultIntoCredentials(
  db: Database.Database,
  backend: CredentialBackend,
  options: ImportFileVaultOptions = {},
): Promise<FileVaultImportResult> {
  const log = options.log ?? (() => {})
  const vault = options.vault ?? defaultVault
  const deleteAfterImport = options.deleteAfterImport !== false

  // Evergreen importer (2026-05-10): runs every boot. The legacy
  // one-shot flag (`file_vault_imported_v1`) is no longer consulted
  // because file-vault writes still happen elsewhere in the codebase
  // (registry.ts, mcp.ts handlers, connector-runtime-setup.ts), so any
  // single-shot guard would orphan everything added between boots.
  // Per-row dedupe via the existing `existingPairs` Set keeps the
  // re-run cheap and lossless — fresh installs with an empty file
  // vault skip the loop body and return immediately.

  const ids = await vault.list()
  if (ids.length === 0) {
    setFlag(db)
    return { ran: true, perConnector: [], skippedRuntime: [] }
  }
  const perConnector: FileVaultImportResult['perConnector'][number][] = []
  const skippedRuntime: string[] = []

  // Pre-compute the existing (forConnector, variableName) pairs so we
  // can dedupe without N round-trips. Same small-N argument as the
  // provider-keys importer.
  const existing = await backend.list({ category: 'mcp-server', includeRevoked: true })
  const existingPairs = new Set(
    existing.map(c => `${c.forConnector ?? ''}::${c.variableName ?? ''}`),
  )

  for (const id of ids) {
    if (parseRuntimeCredentialId(id) !== null) {
      // Per-thread runtime duplicate — handled by C42, not us.
      skippedRuntime.push(id)
      continue
    }

    const importedVars: string[] = []
    const skippedVars: string[] = []
    const errors: string[] = []

    let bundle
    try {
      bundle = await vault.load(id)
    } catch (err) {
      errors.push(`load failed: ${err instanceof Error ? err.message : String(err)}`)
      perConnector.push({ connectorId: id, importedVars, skippedVars, errors, fileDeleted: false })
      continue
    }

    if (!bundle) {
      errors.push('vault.load returned null (file unreadable or missing)')
      perConnector.push({ connectorId: id, importedVars, skippedVars, errors, fileDeleted: false })
      continue
    }

    const entries = Object.entries(bundle.env)
    for (const [variableName, value] of entries) {
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`empty value for variable "${variableName}"`)
        continue
      }
      // POSIX env-var sanity — the unified schema rejects non-POSIX
      // names. Skip (don't error) so a single weird key in an
      // otherwise valid file doesn't block its remaining entries.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
        skippedVars.push(variableName)
        continue
      }

      const dedupeKey = `${id}::${variableName}`
      if (existingPairs.has(dedupeKey)) {
        skippedVars.push(variableName)
        continue
      }

      try {
        await backend.save({
          name: `${id}: ${variableName}`,
          value,
          category: 'mcp-server',
          authType: 'api-key',
          variableName,
          forConnector: id,
          source: 'mcp-config',
        })
        importedVars.push(variableName)
        existingPairs.add(dedupeKey)
      } catch (err) {
        errors.push(
          `save failed for "${variableName}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    let fileDeleted = false
    // Only delete the file when EVERY var imported cleanly. Partial
    // failures keep the file so a re-run can retry the missing vars.
    if (
      deleteAfterImport &&
      errors.length === 0 &&
      importedVars.length > 0 &&
      skippedVars.length === 0
    ) {
      try {
        await vault.delete(id)
        fileDeleted = true
      } catch (err) {
        // Delete failure is logged but does not roll back the import —
        // the rows are already in the DB; the file just lingers.
        log(
          `[credentials] could not delete vault file for "${id}" after import: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    perConnector.push({ connectorId: id, importedVars, skippedVars, errors, fileDeleted })
  }

  setFlag(db)

  const importedCount = perConnector.reduce((sum, c) => sum + c.importedVars.length, 0)
  if (importedCount > 0) {
    log(
      `[credentials] imported ${importedCount} secret(s) from ${perConnector.length} ` +
        `vault file(s) into the unified credentials table`,
    )
  }
  if (skippedRuntime.length > 0) {
    log(
      `[credentials] left ${skippedRuntime.length} per-thread runtime credential file(s) ` +
        `untouched (purged separately by the runtime-cleanup migration)`,
    )
  }

  return { ran: true, perConnector, skippedRuntime }
}

function setFlag(db: Database.Database): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, '1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(FILE_VAULT_IMPORTED_FLAG, now)
}
