/**
 * One-shot import: legacy `provider_keys` table → unified `credentials`
 * table (board: credentials-unification — D8a).
 *
 * Why this migration exists:
 *
 *   The legacy `provider_keys` table encrypts each row with
 *   `scrypt(${hostname}-${username})`. That derivation is a portability
 *   bug masquerading as encryption — rename the host or copy the DB to
 *   another machine and every key becomes unreadable. The unified
 *   `credentials` table uses the same AES-GCM cipher but with the
 *   random master key in `~/.ownware/.master-key`, which doesn't have
 *   either failure mode.
 *
 * Behaviour:
 *
 *   1. Idempotent — gated by an `app_state` flag (`provider_keys_imported_v1`).
 *      Subsequent boots are no-ops.
 *   2. Per-row safe — if a credential already exists in the unified
 *      table for the same `variableName` (e.g. user already saved an
 *      Anthropic key via the new UI), the legacy row is skipped.
 *      Belt-and-suspenders against the flag being cleared by hand.
 *   3. Non-destructive — the legacy `provider_keys` rows are NOT
 *      deleted. They stay until C24 cuts LLM provider adapters over
 *      to the unified credential resolver, at which point a separate
 *      cleanup task drops the table. Until then both tables coexist
 *      and the legacy rows continue to serve LLM calls.
 *   4. Best-effort per row — a single decryption or insert failure
 *      logs the reason and skips that row. Other rows still import.
 *      The flag is set only when at least one row succeeded OR the
 *      legacy table was empty (so an empty install still flips the
 *      flag and avoids re-running the migration on every boot).
 */

import { scryptSync } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import type Database from 'better-sqlite3'
import { decryptValue } from '../../gateway/db/database.js'
import type { CredentialBackend } from '../store/types.js'

// ---------------------------------------------------------------------------
// Constants — kept narrow so a typo can't silently re-import twice
// ---------------------------------------------------------------------------

/** Idempotency flag key. Bumping the suffix forces a re-run. */
export const PROVIDER_KEYS_IMPORTED_FLAG = 'provider_keys_imported_v1'

/** Salt used by `scrypt` in the legacy provider-keys derivation. */
const LEGACY_SCRYPT_SALT = 'cortex-provider-keys-v1'

/**
 * Map a `provider_keys.provider_id` value to the unified credential
 * shape. The variable name here MUST match the env-var name the LLM
 * adapter looks up at resolve time (so the unified resolver finds
 * the right row by `variableName`).
 */
const PROVIDER_TO_DESCRIPTOR: ReadonlyArray<{
  readonly providerId: string
  readonly name: string
  readonly variableName: string
}> = [
  { providerId: 'anthropic', name: 'Anthropic API Key', variableName: 'ANTHROPIC_API_KEY' },
  { providerId: 'openai', name: 'OpenAI API Key', variableName: 'OPENAI_API_KEY' },
  { providerId: 'google', name: 'Google API Key', variableName: 'GOOGLE_API_KEY' },
]

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ProviderKeysImportResult {
  /** True if the importer ran (flag was unset or forceRun was true). */
  readonly ran: boolean
  /** Provider IDs whose legacy row was successfully imported. */
  readonly imported: readonly string[]
  /** Provider IDs whose row was skipped because the credential already existed. */
  readonly alreadyPresent: readonly string[]
  /** Provider IDs that failed to decrypt or insert (one log line per). */
  readonly errors: ReadonlyArray<{ readonly providerId: string; readonly reason: string }>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ProviderKeyRow {
  readonly provider_id: string
  readonly encrypted_key: string
  readonly iv: string
  readonly auth_tag: string
}

function deriveLegacyKey(): Buffer {
  return scryptSync(`${hostname()}-${userInfo().username}`, LEGACY_SCRYPT_SALT, 32)
}

/**
 * Async credential lookup by (category, variableName). The unified
 * backend lists by category then filters in JS — small N (<50 LLM
 * keys per user, ever), so an indexed lookup isn't worth the migration.
 */
async function findExistingByVariableName(
  backend: CredentialBackend,
  variableName: string,
): Promise<boolean> {
  const list = await backend.list({ category: 'llm', includeRevoked: true })
  return list.some(c => c.variableName === variableName)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ImportProviderKeysOptions {
  /** Force the import to run even when the flag is set. Tests only. */
  readonly forceRun?: boolean
  /**
   * Optional log sink — defaults to no-op. Production wiring passes
   * `console.log` so the boot sequence shows what got migrated.
   */
  readonly log?: (message: string) => void
}

/**
 * Run the provider-keys → credentials migration. Safe to call on every
 * boot — re-runs become flag-checks and return immediately.
 */
export async function importProviderKeysIntoCredentials(
  db: Database.Database,
  backend: CredentialBackend,
  options: ImportProviderKeysOptions = {},
): Promise<ProviderKeysImportResult> {
  const log = options.log ?? (() => {})

  const flag = db
    .prepare('SELECT value FROM app_state WHERE key = ?')
    .get(PROVIDER_KEYS_IMPORTED_FLAG) as { value: string } | undefined

  if (flag?.value === '1' && options.forceRun !== true) {
    return { ran: false, imported: [], alreadyPresent: [], errors: [] }
  }

  // Guard: if the legacy provider_keys table was already dropped by a
  // later schema migration (or never existed in this install), the
  // importer has nothing to do. Flip the flag and exit cleanly so the
  // boot sequence never hits a SqliteError on a fresh install.
  const hasLegacyTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_keys'",
    )
    .get() as { name: string } | undefined
  if (!hasLegacyTable) {
    setFlag(db)
    return { ran: true, imported: [], alreadyPresent: [], errors: [] }
  }

  const rows = db
    .prepare('SELECT provider_id, encrypted_key, iv, auth_tag FROM provider_keys')
    .all() as ProviderKeyRow[]

  if (rows.length === 0) {
    setFlag(db)
    return { ran: true, imported: [], alreadyPresent: [], errors: [] }
  }

  const legacyKey = deriveLegacyKey()
  const imported: string[] = []
  const alreadyPresent: string[] = []
  const errors: { providerId: string; reason: string }[] = []

  for (const row of rows) {
    const descriptor = PROVIDER_TO_DESCRIPTOR.find(d => d.providerId === row.provider_id)
    if (!descriptor) {
      // Unknown provider — log and skip. We deliberately do not
      // refuse to flip the flag for this case; an unknown provider
      // is a forward-compat scenario, not an error to retry on.
      log(`[credentials] skipped unknown provider "${row.provider_id}" during import`)
      continue
    }

    if (await findExistingByVariableName(backend, descriptor.variableName)) {
      alreadyPresent.push(row.provider_id)
      continue
    }

    let plaintext: string
    try {
      plaintext = decryptValue(row.encrypted_key, row.iv, row.auth_tag, legacyKey)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      errors.push({ providerId: row.provider_id, reason })
      log(`[credentials] failed to decrypt legacy provider key "${row.provider_id}": ${reason}`)
      continue
    }

    if (plaintext.length === 0) {
      errors.push({ providerId: row.provider_id, reason: 'decrypted value is empty' })
      continue
    }

    try {
      await backend.save({
        name: descriptor.name,
        value: plaintext,
        category: 'llm',
        authType: 'api-key',
        variableName: descriptor.variableName,
        source: 'env-import',
      })
      imported.push(row.provider_id)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      errors.push({ providerId: row.provider_id, reason })
      log(`[credentials] failed to import legacy provider key "${row.provider_id}": ${reason}`)
    }
  }

  // Flip the flag whenever the importer ran end-to-end, even if some
  // rows errored. A row-level error is recorded in `errors` and the
  // operator can re-run with `forceRun: true` after fixing the cause.
  // Re-running the full pass on every boot would be a slow boot loop.
  setFlag(db)

  if (imported.length > 0) {
    log(
      `[credentials] migrated ${imported.length} provider key(s) ` +
        `from legacy scrypt encryption to master-key (${imported.join(', ')})`,
    )
  }
  return { ran: true, imported, alreadyPresent, errors }
}

function setFlag(db: Database.Database): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, '1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(PROVIDER_KEYS_IMPORTED_FLAG, now)
}
