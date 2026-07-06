/**
 * Unit tests — credential backend contract harness.
 *
 * Every credential backend (C04 db-backend, C05 file-vault-backend, any
 * future cloud-sync backend) MUST pass `runBackendContract(makeBackend)`.
 * The harness exercises the full surface area of `CredentialBackend`:
 *
 *   - save → get → list (round-trip + ordering)
 *   - filtering by category, forConnector, tag, includeRevoked
 *   - update (metadata, value rotation, soft-delete via status)
 *   - delete (hard) + idempotency
 *   - decrypt (plaintext discipline)
 *   - schema discipline — every Credential returned MUST validate
 *   - concurrency — parallel saves produce distinct ids
 *
 * The harness is exported so backend test files can import + call it
 * with their own factory (`runBackendContract(() => new DbBackend(...))`).
 *
 * This file ALSO ships a `FakeMemoryBackend` and runs the harness
 * against it. The fake exists to:
 *   1. Prove the harness itself is sound — it must accept a correct
 *      implementation cleanly.
 *   2. Serve as the reference implementation. When a real backend
 *      diverges from the fake's behaviour, the harness names the
 *      divergence in a test failure, not a vague README mismatch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CredentialSchema,
  makeCredentialId,
  maskCredentialValue,
  type Credential,
  type CredentialCategory,
} from '../../../src/credential/schema.js'
import type {
  CredentialBackend,
  CredentialFilter,
  CredentialSaveInput,
  CredentialUpdateInput,
  DecryptedCredential,
} from '../../../src/credential/store/types.js'

// ---------------------------------------------------------------------------
// Reference fake — in-memory backend
// ---------------------------------------------------------------------------

/**
 * In-memory reference implementation. Behaviour mirrors the contract
 * docs in `store/types.ts` exactly — when a real backend disagrees with
 * the fake, the fake is right (or the contract doc needs updating
 * BEFORE the real backend changes).
 */
class FakeMemoryBackend implements CredentialBackend {
  readonly name = 'fake-memory'
  readonly categories: readonly CredentialCategory[]

  private readonly rows = new Map<string, { metadata: Credential; value: string }>()

  constructor(categories: readonly CredentialCategory[] = ['llm', 'tool', 'oauth', 'mcp-server']) {
    this.categories = categories
  }

  async save(input: CredentialSaveInput): Promise<Credential> {
    if (input.value.length === 0) throw new Error('value must be non-empty')
    if (
      (input.authType === 'api-key' || input.authType === 'bearer-token') &&
      input.variableName === undefined
    ) {
      throw new Error(`variableName is required for authType "${input.authType}"`)
    }

    const id = makeCredentialId()
    const now = new Date().toISOString()
    const metadata: Credential = {
      id,
      name: input.name,
      ...(input.variableName !== undefined ? { variableName: input.variableName } : {}),
      category: input.category,
      ...(input.forConnector !== undefined ? { forConnector: input.forConnector } : {}),
      authType: input.authType,
      hint: maskCredentialValue(input.value),
      ...(input.grantedScopes !== undefined ? { grantedScopes: [...input.grantedScopes] } : {}),
      trust: input.trust ?? 'medium',
      ...(input.spendCap !== undefined ? { spendCap: input.spendCap } : {}),
      source: input.source,
      createdAt: now,
      updatedAt: now,
      status: 'ready',
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
    }
    // Defense in depth — any backend output MUST pass the schema.
    CredentialSchema.parse(metadata)
    this.rows.set(id, { metadata, value: input.value })
    return metadata
  }

  async get(id: string): Promise<Credential | null> {
    return this.rows.get(id)?.metadata ?? null
  }

  async list(filter: CredentialFilter = {}): Promise<readonly Credential[]> {
    const includeRevoked = filter.includeRevoked === true
    const out: Credential[] = []
    for (const { metadata } of this.rows.values()) {
      if (!includeRevoked && metadata.status === 'revoked') continue
      if (filter.category !== undefined && metadata.category !== filter.category) continue
      if (
        filter.forConnector !== undefined &&
        metadata.forConnector !== filter.forConnector
      ) continue
      if (
        filter.tag !== undefined &&
        !(metadata.tags ?? []).includes(filter.tag)
      ) continue
      out.push(metadata)
    }
    out.sort((a, b) => {
      const at = Date.parse(a.createdAt)
      const bt = Date.parse(b.createdAt)
      if (at !== bt) return at - bt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return out
  }

  async update(id: string, input: CredentialUpdateInput): Promise<Credential | null> {
    const row = this.rows.get(id)
    if (!row) return null
    const next: Credential = { ...row.metadata }

    if (input.name !== undefined) next.name = input.name
    if (input.tags !== undefined) (next as { tags?: readonly string[] }).tags = [...input.tags]
    if (input.trust !== undefined) next.trust = input.trust

    // Tri-state: undefined leaves alone, null clears, value sets.
    if (input.spendCap !== undefined) {
      if (input.spendCap === null) delete (next as { spendCap?: unknown }).spendCap
      else (next as { spendCap?: unknown }).spendCap = input.spendCap
    }
    if (input.expiresAt !== undefined) {
      if (input.expiresAt === null) delete (next as { expiresAt?: unknown }).expiresAt
      else (next as { expiresAt?: unknown }).expiresAt = input.expiresAt
    }
    if (input.statusReason !== undefined) {
      if (input.statusReason === null) delete (next as { statusReason?: unknown }).statusReason
      else (next as { statusReason?: unknown }).statusReason = input.statusReason
    }
    if (input.grantedScopes !== undefined) {
      if (input.grantedScopes === null) delete (next as { grantedScopes?: unknown }).grantedScopes
      else (next as { grantedScopes?: unknown }).grantedScopes = [...input.grantedScopes]
    }
    if (input.lastUsedAt !== undefined) next.lastUsedAt = input.lastUsedAt
    if (input.status !== undefined) next.status = input.status

    let value = row.value
    if (input.value !== undefined) {
      if (input.value.length === 0) throw new Error('value must be non-empty')
      value = input.value
      next.hint = maskCredentialValue(value)
      // Successful re-encrypt provisionally implies health.
      if (input.status === undefined) next.status = 'ready'
    }

    // Bump updatedAt on every successful update — strictly later than
    // the prior value so the schema's createdAt/updatedAt invariant
    // remains true and SSE invalidation keys advance.
    let candidate = new Date().toISOString()
    if (Date.parse(candidate) <= Date.parse(next.updatedAt)) {
      candidate = new Date(Date.parse(next.updatedAt) + 1).toISOString()
    }
    next.updatedAt = candidate

    CredentialSchema.parse(next)
    this.rows.set(id, { metadata: next, value })
    return next
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id)
  }

  async decrypt(id: string): Promise<DecryptedCredential | null> {
    const row = this.rows.get(id)
    if (!row) return null
    return { metadata: row.metadata, value: row.value }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Standard input fixture for an LLM credential. */
function llmInput(overrides: Partial<CredentialSaveInput> = {}): CredentialSaveInput {
  return {
    name: 'Anthropic Key',
    value: 'sk-ant-api03-XXXXXXXXXXXX-HM8A',
    category: 'llm',
    authType: 'api-key',
    variableName: 'ANTHROPIC_API_KEY',
    source: 'manual',
    ...overrides,
  }
}

/**
 * The contract harness. Call from any backend's test file with a
 * factory that constructs a fresh, empty backend.
 */
export function runBackendContract(makeBackend: () => CredentialBackend): void {
  let backend: CredentialBackend
  beforeEach(() => { backend = makeBackend() })
  afterEach(async () => {
    // Wipe everything for the next run. Backends with a persistent
    // surface (file vault, sqlite) override `makeBackend` to return
    // a per-test-isolated instance, so this loop is safe even there.
    const all = await backend.list({ includeRevoked: true })
    for (const c of all) await backend.delete(c.id)
  })

  it('exposes a stable name + categories', () => {
    expect(backend.name.length).toBeGreaterThan(0)
    expect(backend.categories.length).toBeGreaterThan(0)
  })

  describe('save', () => {
    it('returns metadata that passes CredentialSchema', async () => {
      const cred = await backend.save(llmInput())
      const parsed = CredentialSchema.safeParse(cred)
      expect(parsed.success).toBe(true)
    })

    it('assigns a fresh id with cred_ prefix', async () => {
      const a = await backend.save(llmInput({ name: 'A' }))
      const b = await backend.save(llmInput({ name: 'B' }))
      expect(a.id).toMatch(/^cred_[a-f0-9]{12}$/)
      expect(b.id).toMatch(/^cred_[a-f0-9]{12}$/)
      expect(a.id).not.toBe(b.id)
    })

    it('produces a hint matching maskCredentialValue(value)', async () => {
      const value = 'sk-ant-XXXXXXXX-HM8A'
      const cred = await backend.save(llmInput({ value }))
      expect(cred.hint).toBe(maskCredentialValue(value))
    })

    it('does NOT echo the plaintext value anywhere in the returned metadata', async () => {
      const value = 'sk-ant-PLAINTEXT-LEAK-CHECK-1234'
      const cred = await backend.save(llmInput({ value }))
      expect(JSON.stringify(cred)).not.toContain(value)
    })

    it('throws on empty value', async () => {
      await expect(backend.save(llmInput({ value: '' }))).rejects.toBeDefined()
    })

    it('throws when api-key authType has no variableName', async () => {
      await expect(
        backend.save(llmInput({ variableName: undefined })),
      ).rejects.toBeDefined()
    })

    it('starts new credentials at status "ready"', async () => {
      const cred = await backend.save(llmInput())
      expect(cred.status).toBe('ready')
    })

    it('preserves source / category / forConnector / tags / authType', async () => {
      const cred = await backend.save({
        name: 'GitHub OAuth',
        value: 'ghp_XXXXXXXXXXXXXXXXXXXX',
        category: 'oauth',
        authType: 'oauth2',
        source: 'oauth-flow',
        forConnector: 'composio:github',
        grantedScopes: ['read:user', 'repo'],
        tags: ['work', 'prod'],
      })
      expect(cred.category).toBe('oauth')
      expect(cred.authType).toBe('oauth2')
      expect(cred.source).toBe('oauth-flow')
      expect(cred.forConnector).toBe('composio:github')
      expect(cred.grantedScopes).toEqual(['read:user', 'repo'])
      expect(cred.tags).toEqual(['work', 'prod'])
    })
  })

  describe('get', () => {
    it('returns the saved credential by id', async () => {
      const saved = await backend.save(llmInput())
      const fetched = await backend.get(saved.id)
      expect(fetched).toEqual(saved)
    })

    it('returns null for an unknown id', async () => {
      expect(await backend.get('cred_000000000000')).toBeNull()
    })
  })

  describe('list', () => {
    it('returns saved credentials sorted by createdAt ascending', async () => {
      const a = await backend.save(llmInput({ name: 'A' }))
      // Small delay so backends with millisecond-resolution createdAt
      // produce strictly ascending timestamps. The harness MUST NOT
      // assume a monotonic clock from the backend itself.
      await new Promise(resolve => setTimeout(resolve, 5))
      const b = await backend.save(llmInput({ name: 'B' }))
      const list = await backend.list()
      const idsInOrder = list.map(c => c.id)
      expect(idsInOrder.indexOf(a.id)).toBeLessThan(idsInOrder.indexOf(b.id))
    })

    it('filters by category', async () => {
      await backend.save(llmInput())
      await backend.save({
        name: 'GitHub OAuth',
        value: 'ghp_XXXXXXXXXXXX',
        category: 'oauth',
        authType: 'oauth2',
        source: 'oauth-flow',
      })
      const onlyLlm = await backend.list({ category: 'llm' })
      expect(onlyLlm.every(c => c.category === 'llm')).toBe(true)
      expect(onlyLlm.length).toBe(1)
    })

    it('filters by forConnector', async () => {
      await backend.save(llmInput())
      await backend.save({
        name: 'GitHub OAuth',
        value: 'ghp_XXXXXXXXXXXX',
        category: 'oauth',
        authType: 'oauth2',
        source: 'oauth-flow',
        forConnector: 'composio:github',
      })
      const list = await backend.list({ forConnector: 'composio:github' })
      expect(list.length).toBe(1)
      expect(list[0]!.forConnector).toBe('composio:github')
    })

    it('filters by tag', async () => {
      await backend.save(llmInput({ tags: ['prod'] }))
      await backend.save(llmInput({ name: 'Other', tags: ['dev'] }))
      const list = await backend.list({ tag: 'prod' })
      expect(list.length).toBe(1)
      expect(list[0]!.tags).toContain('prod')
    })

    it('excludes revoked by default', async () => {
      const a = await backend.save(llmInput())
      await backend.update(a.id, { status: 'revoked', statusReason: 'user removed' })
      const list = await backend.list()
      expect(list.find(c => c.id === a.id)).toBeUndefined()
    })

    it('includes revoked when filter.includeRevoked === true', async () => {
      const a = await backend.save(llmInput())
      await backend.update(a.id, { status: 'revoked', statusReason: 'user removed' })
      const list = await backend.list({ includeRevoked: true })
      expect(list.find(c => c.id === a.id)).toBeDefined()
    })

    it('returns deterministic ordering across calls', async () => {
      for (let i = 0; i < 5; i++) {
        await backend.save(llmInput({ name: `K${i}` }))
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      const a = (await backend.list()).map(c => c.id)
      const b = (await backend.list()).map(c => c.id)
      expect(a).toEqual(b)
    })

    it('does NOT return plaintext value anywhere', async () => {
      const value = 'sk-ant-LEAK-CHECK-LIST-9999'
      await backend.save(llmInput({ value }))
      const list = await backend.list()
      expect(JSON.stringify(list)).not.toContain(value)
    })
  })

  describe('update', () => {
    it('patches name + trust + tags + lastUsedAt', async () => {
      const a = await backend.save(llmInput())
      const updated = await backend.update(a.id, {
        name: 'Renamed',
        trust: 'high',
        tags: ['ops'],
        lastUsedAt: new Date().toISOString(),
      })
      expect(updated?.name).toBe('Renamed')
      expect(updated?.trust).toBe('high')
      expect(updated?.tags).toEqual(['ops'])
      expect(updated?.lastUsedAt).toBeDefined()
    })

    it('rotates value: hint changes, status reset to ready', async () => {
      const a = await backend.save(llmInput({ value: 'sk-old-XXXXXXXX-OLD1' }))
      await backend.update(a.id, { status: 'expired', statusReason: 'rotated' })
      const rotated = await backend.update(a.id, { value: 'sk-new-XXXXXXXX-NEW2' })
      expect(rotated?.hint).toBe(maskCredentialValue('sk-new-XXXXXXXX-NEW2'))
      expect(rotated?.status).toBe('ready')
      const decrypted = await backend.decrypt(a.id)
      expect(decrypted?.value).toBe('sk-new-XXXXXXXX-NEW2')
    })

    it('bumps updatedAt strictly later than previous updatedAt', async () => {
      const a = await backend.save(llmInput())
      const updated = await backend.update(a.id, { name: 'New name' })
      expect(updated).not.toBeNull()
      expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(a.updatedAt))
    })

    it('soft-delete via status: revoked + statusReason', async () => {
      const a = await backend.save(llmInput())
      const revoked = await backend.update(a.id, {
        status: 'revoked',
        statusReason: 'user removed',
      })
      expect(revoked?.status).toBe('revoked')
      expect(revoked?.statusReason).toBe('user removed')
      // Still retrievable by id (soft-delete keeps the row).
      expect(await backend.get(a.id)).not.toBeNull()
    })

    it('clears spendCap when set to null', async () => {
      const a = await backend.save(llmInput({ spendCap: { amountUsd: 5, period: 'day' } }))
      const updated = await backend.update(a.id, { spendCap: null })
      expect(updated?.spendCap).toBeUndefined()
    })

    it('clears expiresAt when set to null', async () => {
      const a = await backend.save(llmInput({ expiresAt: '2099-01-01T00:00:00.000Z' }))
      const updated = await backend.update(a.id, { expiresAt: null })
      expect(updated?.expiresAt).toBeUndefined()
    })

    it('returns null for an unknown id', async () => {
      expect(await backend.update('cred_000000000000', { name: 'x' })).toBeNull()
    })

    it('throws on empty value rotation', async () => {
      const a = await backend.save(llmInput())
      await expect(backend.update(a.id, { value: '' })).rejects.toBeDefined()
    })

    it('does NOT echo the rotated plaintext value in metadata', async () => {
      const a = await backend.save(llmInput())
      const value = 'sk-ant-LEAK-CHECK-UPDATE-7777'
      const updated = await backend.update(a.id, { value })
      expect(JSON.stringify(updated)).not.toContain(value)
    })
  })

  describe('delete', () => {
    it('hard-deletes; subsequent get returns null', async () => {
      const a = await backend.save(llmInput())
      const removed = await backend.delete(a.id)
      expect(removed).toBe(true)
      expect(await backend.get(a.id)).toBeNull()
    })

    it('returns false for an unknown id', async () => {
      expect(await backend.delete('cred_000000000000')).toBe(false)
    })

    it('removes from list', async () => {
      const a = await backend.save(llmInput())
      await backend.delete(a.id)
      const list = await backend.list({ includeRevoked: true })
      expect(list.find(c => c.id === a.id)).toBeUndefined()
    })
  })

  describe('decrypt', () => {
    it('returns plaintext value + metadata', async () => {
      const value = 'sk-ant-XXXXXXXX-HM8A'
      const a = await backend.save(llmInput({ value }))
      const decrypted = await backend.decrypt(a.id)
      expect(decrypted?.value).toBe(value)
      expect(decrypted?.metadata.id).toBe(a.id)
    })

    it('returns null for an unknown id', async () => {
      expect(await backend.decrypt('cred_000000000000')).toBeNull()
    })
  })

  describe('concurrency', () => {
    it('parallel saves produce distinct ids', async () => {
      const saves = Array.from({ length: 20 }, (_, i) =>
        backend.save(llmInput({ name: `K${i}` })),
      )
      const results = await Promise.all(saves)
      const ids = new Set(results.map(c => c.id))
      expect(ids.size).toBe(20)
    })
  })
}

// ---------------------------------------------------------------------------
// Self-test — the harness must accept a correct implementation.
// ---------------------------------------------------------------------------

describe('FakeMemoryBackend (reference implementation)', () => {
  runBackendContract(() => new FakeMemoryBackend())
})

// Re-export for backend tests that want the same fixture surface.
export { FakeMemoryBackend, llmInput }
