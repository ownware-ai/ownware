import { createHash } from 'node:crypto'
import {
  decrypt as decryptCredential,
  encryptV2,
} from '../connector/credentials/vault.js'
import {
  CredentialSchema,
  isCredentialId,
  makeCredentialId,
  maskCredentialValue,
  type Credential,
} from '../credential/schema.js'
import type {
  CredentialStore,
} from '../credential/store/index.js'
import type {
  CredentialConditionalUpdateResult,
  CredentialFilter,
  CredentialSaveInput,
  CredentialUpdateInput,
  CredentialWriteCondition,
  DecryptedCredential,
} from '../credential/store/types.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  repositoryCall,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

interface CredentialRow {
  readonly id: string
  readonly name: string
  readonly variable_name: string | null
  readonly category: string
  readonly for_connector: string | null
  readonly auth_type: string
  readonly encrypted_value: string
  readonly hint: string
  readonly granted_scopes: string | null
  readonly trust: string
  readonly spend_cap: string | null
  readonly source: string
  readonly status: string
  readonly status_reason: string | null
  readonly expires_at: string | null
  readonly last_used_at: string | null
  readonly tags: string | null
  readonly created_at: string
  readonly updated_at: string
}

const COLUMNS = `
  id, name, variable_name, category, for_connector, auth_type,
  encrypted_value, hint, granted_scopes, trust, spend_cap, source,
  status, status_reason, expires_at, last_used_at, tags, created_at, updated_at
`

function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null || raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function rowToCredential(row: CredentialRow): Credential {
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
  if (row.status_reason !== null) candidate['statusReason'] = row.status_reason
  if (row.expires_at !== null) candidate['expiresAt'] = row.expires_at
  if (row.last_used_at !== null) candidate['lastUsedAt'] = row.last_used_at
  const grantedScopes = parseJson<readonly string[]>(row.granted_scopes)
  const spendCap = parseJson<Credential['spendCap']>(row.spend_cap)
  const tags = parseJson<readonly string[]>(row.tags)
  if (grantedScopes !== undefined) candidate['grantedScopes'] = grantedScopes
  if (spendCap !== undefined) candidate['spendCap'] = spendCap
  if (tags !== undefined) candidate['tags'] = tags
  return CredentialSchema.parse(candidate)
}

function revision(encryptedValue: string): string {
  return createHash('sha256').update(encryptedValue).digest('hex')
}

function writeValues(metadata: Credential, encryptedValue: string): readonly unknown[] {
  return [
    metadata.id,
    metadata.name,
    metadata.variableName ?? null,
    metadata.category,
    metadata.forConnector ?? null,
    metadata.authType,
    encryptedValue,
    metadata.hint,
    metadata.grantedScopes ? JSON.stringify(metadata.grantedScopes) : null,
    metadata.trust,
    metadata.spendCap ? JSON.stringify(metadata.spendCap) : null,
    metadata.source,
    metadata.status,
    metadata.statusReason ?? null,
    metadata.expiresAt ?? null,
    metadata.lastUsedAt ?? null,
    metadata.tags ? JSON.stringify(metadata.tags) : null,
    metadata.createdAt,
    metadata.updatedAt,
  ]
}

async function selectCredential(
  client: PostgreSqlQueryClient,
  id: string,
  forUpdate = false,
): Promise<CredentialRow | undefined> {
  const result = await client.query<CredentialRow>(
    `SELECT ${COLUMNS} FROM ownware.credentials WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  )
  return result.rows[0]
}

function nextMetadata(
  row: CredentialRow,
  input: CredentialUpdateInput,
): { readonly metadata: Credential; readonly encryptedValue: string } {
  const current = rowToCredential(row)
  const next: Record<string, unknown> = { ...current }
  if (input.name !== undefined) next['name'] = input.name
  if (input.tags !== undefined) next['tags'] = [...input.tags]
  if (input.trust !== undefined) next['trust'] = input.trust
  if (input.lastUsedAt !== undefined) next['lastUsedAt'] = input.lastUsedAt
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

  let encryptedValue = row.encrypted_value
  if (input.value !== undefined) {
    encryptedValue = encryptV2(input.value)
    next['hint'] = input.hint ?? maskCredentialValue(input.value)
    if (input.status === undefined) next['status'] = 'ready'
    if (input.statusReason === undefined && next['status'] === 'ready') {
      delete next['statusReason']
    }
  }
  let updatedAt = new Date().toISOString()
  if (Date.parse(updatedAt) <= Date.parse(current.updatedAt)) {
    updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString()
  }
  next['updatedAt'] = updatedAt
  return { metadata: CredentialSchema.parse(next), encryptedValue }
}

async function updateRow(
  client: PostgreSqlQueryClient,
  metadata: Credential,
  encryptedValue: string,
): Promise<void> {
  const values = writeValues(metadata, encryptedValue)
  await client.query(`
    UPDATE ownware.credentials SET
      name = $2, variable_name = $3, category = $4, for_connector = $5,
      auth_type = $6, encrypted_value = $7, hint = $8, granted_scopes = $9,
      trust = $10, spend_cap = $11, source = $12, status = $13,
      status_reason = $14, expires_at = $15, last_used_at = $16, tags = $17,
      created_at = $18, updated_at = $19
    WHERE id = $1
  `, [...values])
}

/** PostgreSQL credential authority. Plaintext leaves this object only from decrypt(). */
export function createPostgreSqlCredentialRepository(
  context: PostgreSqlRootRepositoryContext,
): CredentialStore {
  return {
    name: 'postgresql-credentials',
    categories: ['llm', 'tool', 'oauth', 'mcp-server'],

    save(input: CredentialSaveInput): Promise<Credential> {
      return repositoryCall(context, 'credentials', 'save', 'write_failed', async (client) => {
        if (typeof input.value !== 'string' || input.value.length === 0) {
          throw new Error('credential value is invalid')
        }
        if (
          (input.authType === 'api-key' || input.authType === 'bearer-token') &&
          !input.variableName
        ) {
          throw new Error('credential variable name is required')
        }
        const now = new Date().toISOString()
        const candidate: Record<string, unknown> = {
          id: makeCredentialId(),
          name: input.name,
          category: input.category,
          authType: input.authType,
          hint: input.hint ?? maskCredentialValue(input.value),
          trust: input.trust ?? 'medium',
          source: input.source,
          status: 'ready',
          createdAt: now,
          updatedAt: now,
        }
        if (input.variableName !== undefined) candidate['variableName'] = input.variableName
        if (input.forConnector !== undefined) candidate['forConnector'] = input.forConnector
        if (input.grantedScopes !== undefined) candidate['grantedScopes'] = [...input.grantedScopes]
        if (input.spendCap !== undefined) candidate['spendCap'] = input.spendCap
        if (input.expiresAt !== undefined) candidate['expiresAt'] = input.expiresAt
        if (input.tags !== undefined) candidate['tags'] = [...input.tags]
        const metadata = CredentialSchema.parse(candidate)
        const encryptedValue = encryptV2(input.value)
        const values = writeValues(metadata, encryptedValue)
        await client.query(`
          INSERT INTO ownware.credentials (${COLUMNS})
          VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})
        `, [...values])
        return metadata
      })
    },

    get(id: string): Promise<Credential | null> {
      if (!isCredentialId(id)) return Promise.resolve(null)
      return repositoryCall(context, 'credentials', 'get', 'read_failed', async (client) => {
        const row = await selectCredential(client, id)
        return row === undefined ? null : rowToCredential(row)
      })
    },

    list(filter: CredentialFilter = {}): Promise<readonly Credential[]> {
      return repositoryCall(context, 'credentials', 'list', 'read_failed', async (client) => {
        const clauses: string[] = []
        const values: unknown[] = []
        if (filter.category !== undefined) {
          values.push(filter.category)
          clauses.push(`category = $${values.length}`)
        }
        if (filter.forConnector !== undefined) {
          values.push(filter.forConnector)
          clauses.push(`for_connector = $${values.length}`)
        }
        if (filter.includeRevoked !== true) clauses.push("status <> 'revoked'")
        const result = await client.query<CredentialRow>(`
          SELECT ${COLUMNS} FROM ownware.credentials
          ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
          ORDER BY created_at ASC, id ASC
        `, values)
        let credentials = result.rows.map(rowToCredential)
        if (filter.tag !== undefined) {
          credentials = credentials.filter((item) => (item.tags ?? []).includes(filter.tag!))
        }
        return credentials
      })
    },

    async update(id: string, input: CredentialUpdateInput): Promise<Credential | null> {
      const result = await applyUpdate(context, id, input)
      return result.kind === 'updated' ? result.credential : null
    },

    updateIfUnchanged(
      id: string,
      expected: CredentialWriteCondition,
      input: CredentialUpdateInput,
    ): Promise<CredentialConditionalUpdateResult> {
      if (!/^[0-9a-f]{64}$/.test(expected.valueRevision) ||
        !['ready', 'expired', 'error', 'revoked'].includes(expected.status)) {
        return Promise.reject(new Error('credential write condition is invalid'))
      }
      return applyUpdate(context, id, input, expected)
    },

    delete(id: string): Promise<boolean> {
      if (!isCredentialId(id)) return Promise.resolve(false)
      return repositoryCall(context, 'credentials', 'delete', 'write_failed', async (client) => {
        const result = await client.query('DELETE FROM ownware.credentials WHERE id = $1', [id])
        return result.rowCount === 1
      })
    },

    decrypt(id: string): Promise<DecryptedCredential | null> {
      if (!isCredentialId(id)) return Promise.resolve(null)
      return repositoryCall(context, 'credentials', 'decrypt', 'read_failed', async (client) => {
        const row = await selectCredential(client, id)
        if (row === undefined) return null
        const value = decryptCredential(row.encrypted_value)
        if (value === null) return null
        return {
          metadata: rowToCredential(row),
          value,
          valueRevision: revision(row.encrypted_value),
        }
      })
    },
  }
}

function applyUpdate(
  context: PostgreSqlRootRepositoryContext,
  id: string,
  input: CredentialUpdateInput,
  expected?: CredentialWriteCondition,
): Promise<CredentialConditionalUpdateResult> {
  if (!isCredentialId(id)) return Promise.resolve({ kind: 'missing' })
  if (input.value !== undefined && input.value.length === 0) {
    return Promise.reject(new Error('credential value is invalid'))
  }
  return repositoryCall(
    context,
    'credentials',
    expected === undefined ? 'update' : 'update_if_unchanged',
    'write_failed',
    async () =>
    withPostgreSqlTransaction(context.pool, async (client) => {
      const row = await selectCredential(client, id, true)
      if (row === undefined) return { kind: 'missing' }
      const current = rowToCredential(row)
      if (expected !== undefined &&
        (revision(row.encrypted_value) !== expected.valueRevision || current.status !== expected.status)) {
        return { kind: 'conflict' }
      }
      const next = nextMetadata(row, input)
      await updateRow(client, next.metadata, next.encryptedValue)
      return { kind: 'updated', credential: next.metadata }
    }),
  )
}
