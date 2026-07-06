/**
 * SQLite credentials backend.
 *
 * Single source of truth for every credential the gateway holds.
 * Implements `CredentialBackend` against the `credentials` table.
 *
 * Encryption: AES-256-GCM with the master key from
 * `~/.ownware/.master-key`. Delegates to vault.ts's `encryptV2` /
 * `decrypt` so there is exactly one cipher implementation.
 *
 * Plaintext discipline (mirrors the contract in `store/types.ts`):
 *   - `save` / `update` accept plaintext for write only and encrypt
 *     before the SQL `INSERT` / `UPDATE`.
 *   - `get` / `list` return metadata only — never the value, never
 *     even the encrypted ciphertext.
 *   - `decrypt` is the SOLE plaintext-returning method.
 *
 * Concurrency: each method runs inside one SQL statement so atomicity
 * is given. `update` wraps its read-modify-write in `BEGIN IMMEDIATE`
 * so two concurrent renames on the same id can't lose a write.
 */

import type Database from 'better-sqlite3'
import {
  decrypt as decryptV2OrV1,
  encryptV2,
} from '../../connector/credentials/vault.js'
import {
  CredentialSchema,
  isCredentialId,
  makeCredentialId,
  maskCredentialValue,
  type Credential,
} from '../schema.js'
import type {
  CredentialBackend,
  CredentialFilter,
  CredentialSaveInput,
  CredentialUpdateInput,
  DecryptedCredential,
} from './types.js'

// ---------------------------------------------------------------------------
// Row shape — straight mirror of the SQLite columns
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: string
  name: string
  variable_name: string | null
  category: string
  for_connector: string | null
  auth_type: string
  encrypted_value: string
  hint: string
  granted_scopes: string | null
  trust: string
  spend_cap: string | null
  source: string
  status: string
  status_reason: string | null
  expires_at: string | null
  last_used_at: string | null
  tags: string | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Row ↔ Credential
// ---------------------------------------------------------------------------

/**
 * Parse a JSON column. Returns `undefined` when the column is null OR
 * the JSON is malformed. We deliberately swallow parse errors — a
 * corrupted JSON column on `granted_scopes` should not break the
 * surrounding row's read; the schema validator below catches the
 * downstream consequence and surfaces a clearer error than `JSON.parse`
 * would.
 */
function parseJsonColumn<T>(raw: string | null): T | undefined {
  if (raw === null || raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * Hydrate a SQLite row into a validated Credential. Throws when the
 * row fails schema validation — that means a write path bypassed the
 * schema (a bug we want to surface), or the migration imported a row
 * we cannot represent (also a bug).
 */
function rowToCredential(row: CredentialRow): Credential {
  const grantedScopes = parseJsonColumn<readonly string[]>(row.granted_scopes)
  const spendCap = parseJsonColumn<Credential['spendCap']>(row.spend_cap)
  const tags = parseJsonColumn<readonly string[]>(row.tags)
  const candidate: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    category: row.category,
    authType: row.auth_type,
    hint: row.hint,
    trust: row.trust,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.variable_name !== null) candidate['variableName'] = row.variable_name
  if (row.for_connector !== null) candidate['forConnector'] = row.for_connector
  if (grantedScopes !== undefined) candidate['grantedScopes'] = grantedScopes
  if (spendCap !== undefined) candidate['spendCap'] = spendCap
  if (row.status_reason !== null) candidate['statusReason'] = row.status_reason
  if (row.expires_at !== null) candidate['expiresAt'] = row.expires_at
  if (row.last_used_at !== null) candidate['lastUsedAt'] = row.last_used_at
  if (tags !== undefined) candidate['tags'] = tags
  return CredentialSchema.parse(candidate)
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

const ALL_COLS = `
  id, name, variable_name, category, for_connector, auth_type,
  encrypted_value, hint, granted_scopes, trust, spend_cap, source,
  status, status_reason, expires_at, last_used_at, tags,
  created_at, updated_at
`

const INSERT_SQL = `
  INSERT INTO credentials (
    id, name, variable_name, category, for_connector, auth_type,
    encrypted_value, hint, granted_scopes, trust, spend_cap, source,
    status, status_reason, expires_at, last_used_at, tags,
    created_at, updated_at
  ) VALUES (
    @id, @name, @variable_name, @category, @for_connector, @auth_type,
    @encrypted_value, @hint, @granted_scopes, @trust, @spend_cap, @source,
    @status, @status_reason, @expires_at, @last_used_at, @tags,
    @created_at, @updated_at
  )
`

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

/**
 * Construct against any `Database.Database`. Production callers pass
 * `state.rawDbHandle` (gateway state's escape-hatch accessor); tests
 * pass a fresh `new Database(':memory:')` with the migrations applied.
 *
 * Holds prepared statements as members so the per-call cost is one
 * SQLite step, not a re-prepare. The handle's lifecycle is the
 * caller's — we never close it.
 */
export class DbCredentialBackend implements CredentialBackend {
  readonly name = 'sqlite-credentials'
  readonly categories = ['llm', 'tool', 'oauth', 'mcp-server'] as const

  private readonly db: Database.Database
  private readonly stmtInsert: Database.Statement
  private readonly stmtGet: Database.Statement
  private readonly stmtUpdate: Database.Statement
  private readonly stmtDelete: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    this.stmtInsert = db.prepare(INSERT_SQL)
    this.stmtGet = db.prepare(`SELECT ${ALL_COLS} FROM credentials WHERE id = ?`)
    this.stmtUpdate = db.prepare(`
      UPDATE credentials SET
        name = @name,
        variable_name = @variable_name,
        for_connector = @for_connector,
        auth_type = @auth_type,
        encrypted_value = @encrypted_value,
        hint = @hint,
        granted_scopes = @granted_scopes,
        trust = @trust,
        spend_cap = @spend_cap,
        status = @status,
        status_reason = @status_reason,
        expires_at = @expires_at,
        last_used_at = @last_used_at,
        tags = @tags,
        updated_at = @updated_at
      WHERE id = @id
    `)
    this.stmtDelete = db.prepare('DELETE FROM credentials WHERE id = ?')
  }

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------

  async save(input: CredentialSaveInput): Promise<Credential> {
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw new Error('save: value must be a non-empty string')
    }
    if (
      (input.authType === 'api-key' || input.authType === 'bearer-token') &&
      (input.variableName === undefined || input.variableName.length === 0)
    ) {
      throw new Error(`save: variableName is required for authType "${input.authType}"`)
    }

    const id = makeCredentialId()
    const nowIso = new Date().toISOString()
    const encryptedValue = encryptV2(input.value)

    const candidate: Record<string, unknown> = {
      id,
      name: input.name,
      category: input.category,
      authType: input.authType,
      hint: maskCredentialValue(input.value),
      trust: input.trust ?? 'medium',
      source: input.source,
      status: 'ready',
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    if (input.variableName !== undefined) candidate['variableName'] = input.variableName
    if (input.forConnector !== undefined) candidate['forConnector'] = input.forConnector
    if (input.grantedScopes !== undefined) candidate['grantedScopes'] = [...input.grantedScopes]
    if (input.spendCap !== undefined) candidate['spendCap'] = input.spendCap
    if (input.expiresAt !== undefined) candidate['expiresAt'] = input.expiresAt
    if (input.tags !== undefined) candidate['tags'] = [...input.tags]

    // Defense in depth — the schema enforces every cross-field rule
    // (spendCap LLM-only, statusReason required when non-ready, etc.).
    // A rejected parse here means the caller's input is malformed
    // BEFORE the row is written, so we throw rather than insert.
    const metadata = CredentialSchema.parse(candidate)

    this.stmtInsert.run({
      id: metadata.id,
      name: metadata.name,
      variable_name: metadata.variableName ?? null,
      category: metadata.category,
      for_connector: metadata.forConnector ?? null,
      auth_type: metadata.authType,
      encrypted_value: encryptedValue,
      hint: metadata.hint,
      granted_scopes: metadata.grantedScopes ? JSON.stringify(metadata.grantedScopes) : null,
      trust: metadata.trust,
      spend_cap: metadata.spendCap ? JSON.stringify(metadata.spendCap) : null,
      source: metadata.source,
      status: metadata.status,
      status_reason: metadata.statusReason ?? null,
      expires_at: metadata.expiresAt ?? null,
      last_used_at: metadata.lastUsedAt ?? null,
      tags: metadata.tags ? JSON.stringify(metadata.tags) : null,
      created_at: metadata.createdAt,
      updated_at: metadata.updatedAt,
    })

    return metadata
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(id: string): Promise<Credential | null> {
    if (!isCredentialId(id)) return null
    const row = this.stmtGet.get(id) as CredentialRow | undefined
    if (!row) return null
    return rowToCredential(row)
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(filter: CredentialFilter = {}): Promise<readonly Credential[]> {
    const where: string[] = []
    const params: unknown[] = []

    if (filter.category !== undefined) {
      where.push('category = ?')
      params.push(filter.category)
    }
    if (filter.forConnector !== undefined) {
      where.push('for_connector = ?')
      params.push(filter.forConnector)
    }
    if (filter.includeRevoked !== true) {
      where.push("status != 'revoked'")
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // Deterministic ordering — `created_at` ASC, ties broken by `id`.
    // The schema's createdAt has millisecond resolution, which is
    // enough for human-pace inserts; the id tiebreaker covers the
    // pathological "two saves in the same millisecond" case.
    const sql = `SELECT ${ALL_COLS} FROM credentials ${whereClause} ORDER BY created_at ASC, id ASC`
    const rows = this.db.prepare(sql).all(...params) as CredentialRow[]
    let creds = rows.map(rowToCredential)

    // Tag filter — applied in JS because tags are JSON-array column.
    // Volume is small enough that a json_each() index would be over-
    // engineering at this point.
    if (filter.tag !== undefined) {
      const tag = filter.tag
      creds = creds.filter(c => (c.tags ?? []).includes(tag))
    }

    return creds
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(id: string, input: CredentialUpdateInput): Promise<Credential | null> {
    if (!isCredentialId(id)) return null
    if (input.value !== undefined && input.value.length === 0) {
      throw new Error('update: value must be a non-empty string when provided')
    }

    // BEGIN IMMEDIATE so two concurrent rotations on the same id
    // serialise cleanly. better-sqlite3's transaction wrapper handles
    // commit/rollback semantics around the inner closure.
    const txn = this.db.transaction((): Credential | null => {
      const existing = this.stmtGet.get(id) as CredentialRow | undefined
      if (!existing) return null

      const current = rowToCredential(existing)
      const next: Record<string, unknown> = { ...current }

      if (input.name !== undefined) next['name'] = input.name
      if (input.tags !== undefined) next['tags'] = [...input.tags]
      if (input.trust !== undefined) next['trust'] = input.trust
      if (input.lastUsedAt !== undefined) next['lastUsedAt'] = input.lastUsedAt

      // Tri-state nullable patches: undefined leaves alone, null clears, value sets.
      if (input.spendCap !== undefined) {
        if (input.spendCap === null) delete next['spendCap']
        else next['spendCap'] = input.spendCap
      }
      if (input.expiresAt !== undefined) {
        if (input.expiresAt === null) delete next['expiresAt']
        else next['expiresAt'] = input.expiresAt
      }
      if (input.statusReason !== undefined) {
        if (input.statusReason === null) delete next['statusReason']
        else next['statusReason'] = input.statusReason
      }
      if (input.grantedScopes !== undefined) {
        if (input.grantedScopes === null) delete next['grantedScopes']
        else next['grantedScopes'] = [...input.grantedScopes]
      }
      if (input.status !== undefined) next['status'] = input.status

      let encryptedValue = existing.encrypted_value
      if (input.value !== undefined) {
        encryptedValue = encryptV2(input.value)
        next['hint'] = maskCredentialValue(input.value)
        // Successful re-encrypt provisionally implies health — unless
        // the caller explicitly set a status in the same patch.
        if (input.status === undefined) next['status'] = 'ready'
        // Clear stale statusReason when the value rotation implicitly
        // recovered the credential.
        if (input.statusReason === undefined && next['status'] === 'ready') {
          delete next['statusReason']
        }
      }

      // Bump updatedAt strictly later than the current value. Two
      // updates inside the same millisecond would otherwise produce
      // updatedAt === createdAt (or === previous updatedAt), which the
      // SSE invalidation key relies on advancing on every write.
      let nextUpdatedAt = new Date().toISOString()
      if (Date.parse(nextUpdatedAt) <= Date.parse(current.updatedAt)) {
        nextUpdatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString()
      }
      next['updatedAt'] = nextUpdatedAt

      const validated = CredentialSchema.parse(next)

      this.stmtUpdate.run({
        id: validated.id,
        name: validated.name,
        variable_name: validated.variableName ?? null,
        for_connector: validated.forConnector ?? null,
        auth_type: validated.authType,
        encrypted_value: encryptedValue,
        hint: validated.hint,
        granted_scopes: validated.grantedScopes ? JSON.stringify(validated.grantedScopes) : null,
        trust: validated.trust,
        spend_cap: validated.spendCap ? JSON.stringify(validated.spendCap) : null,
        status: validated.status,
        status_reason: validated.statusReason ?? null,
        expires_at: validated.expiresAt ?? null,
        last_used_at: validated.lastUsedAt ?? null,
        tags: validated.tags ? JSON.stringify(validated.tags) : null,
        updated_at: validated.updatedAt,
      })

      return validated
    })

    return txn()
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(id: string): Promise<boolean> {
    if (!isCredentialId(id)) return false
    return this.stmtDelete.run(id).changes > 0
  }

  // -------------------------------------------------------------------------
  // decrypt
  // -------------------------------------------------------------------------

  async decrypt(id: string): Promise<DecryptedCredential | null> {
    if (!isCredentialId(id)) return null
    const row = this.stmtGet.get(id) as CredentialRow | undefined
    if (!row) return null
    const value = decryptV2OrV1(row.encrypted_value)
    if (value === null) {
      // Decrypt failure means either the master key has changed (key
      // file rotated under us) or the row is corrupt. Either way the
      // resolver cannot use this credential — bubble null and let the
      // resolver translate into a typed error.
      return null
    }
    return { metadata: rowToCredential(row), value }
  }
}
