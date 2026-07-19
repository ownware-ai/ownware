import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InstallIdentity } from '../../../src/identity/install-identity.js'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const ConnectionListSchema = z.object({
  items: z.array(z.object({
    connectionId: z.string().uuid(),
    capabilityId: z.string().min(1),
    status: z.enum(['pending', 'connected', 'failed', 'expired']),
    recovery: z.enum([
      'none', 'complete_connection', 'reconnect', 'verify_revocation',
    ]),
    changedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    lastVerifiedAt: z.number().int().nonnegative().nullable(),
  }).strict()),
  nextCursor: z.string().uuid().nullable(),
  accessPolicy: z.literal('separate_grant_required'),
}).strict()

describe('Contract: owner connection inventory', () => {
  let gateway: TestGateway
  let delegatedToken: string

  beforeAll(async () => {
    gateway = await createTestGateway({ disableAuth: false })
    seedConnections(gateway)
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir, 'Connection inventory contract',
    ).id
    const delegation = await fetch(`${gateway.baseUrl}/api/v1/auth/delegations`, {
      method: 'POST',
      headers: ownerHeaders(gateway),
      body: JSON.stringify({
        delegateId: 'connection-inventory-delegate',
        workspaceId,
        profileId: 'mini',
        purpose: 'connection_administration',
        channel: 'web.primary',
        operations: ['connections.list'],
      }),
    })
    expect(delegation.status).toBe(201)
    delegatedToken = ((await delegation.json()) as { token: string }).token
  })

  afterAll(async () => {
    await gateway.stop()
  })

  it('returns only latest safe states and never implies that connection grants access', async () => {
    const response = await fetch(`${gateway.baseUrl}/api/v1/connections`, {
      headers: ownerHeaders(gateway),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('etag')).toBeNull()
    const raw = await response.text()
    const page = ConnectionListSchema.parse(JSON.parse(raw))
    expect(page.accessPolicy).toBe('separate_grant_required')
    expect(page.nextCursor).toBeNull()
    expect(page.items.map(({ capabilityId, status, recovery }) => ({
      capabilityId, status, recovery,
    }))).toEqual([
      { capabilityId: 'calendar', status: 'pending', recovery: 'complete_connection' },
      { capabilityId: 'mail', status: 'connected', recovery: 'none' },
      { capabilityId: 'crm', status: 'failed', recovery: 'reconnect' },
      { capabilityId: 'storage', status: 'expired', recovery: 'reconnect' },
      { capabilityId: 'billing', status: 'failed', recovery: 'verify_revocation' },
      { capabilityId: 'figma', status: 'connected', recovery: 'none' },
    ])
    expect(page.items.every((item) => item.connectionId !== 'vendor-account-canary'))
      .toBe(true)
    for (const canary of [
      'vendor-account-canary', 'vendor-user-canary', 'auth-config-canary',
      'install-identity-canary', 'session-handle-canary', 'raw-provider-error-canary',
      'https://provider.invalid/authorization', 'revoked-capability',
      'older-failed-state',
    ]) expect(raw).not.toContain(canary)
    for (const internalKey of [
      'source', 'entityId', 'authConfigId', 'vendorAccountId', 'vendorUserId',
      'metadata', 'sessionHandle', 'errorReason', 'lastPolledAt', 'terminalCause',
    ]) expect(raw).not.toContain(internalKey)
  })

  it('paginates with only an Ownware public UUID cursor', async () => {
    const firstResponse = await fetch(`${gateway.baseUrl}/api/v1/connections?limit=2`, {
      headers: ownerHeaders(gateway),
    })
    expect(firstResponse.status).toBe(200)
    const first = ConnectionListSchema.parse(await firstResponse.json())
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe(first.items[1]?.connectionId)
    expect(first.nextCursor).not.toContain('vendor')

    const secondResponse = await fetch(
      `${gateway.baseUrl}/api/v1/connections?limit=2&cursor=${first.nextCursor}`,
      { headers: ownerHeaders(gateway) },
    )
    expect(secondResponse.status).toBe(200)
    const second = ConnectionListSchema.parse(await secondResponse.json())
    expect(second.items).toHaveLength(2)
    expect(second.items.map((item) => item.connectionId))
      .not.toEqual(expect.arrayContaining(first.items.map((item) => item.connectionId)))
  })

  it('rejects unauthenticated, delegated and auth-disabled enumeration', async () => {
    expect((await fetch(`${gateway.baseUrl}/api/v1/connections`)).status).toBe(401)

    const delegated = await fetch(`${gateway.baseUrl}/api/v1/connections`, {
      headers: { Authorization: `Bearer ${delegatedToken}` },
    })
    expect(delegated.status).toBe(403)
    await expect(delegated.json()).resolves.toMatchObject({ error: 'owner_required' })

    const local = await createTestGateway({ disableAuth: true })
    try {
      const authDisabled = await fetch(`${local.baseUrl}/api/v1/connections`)
      expect(authDisabled.status).toBe(409)
      await expect(authDisabled.json()).resolves.toMatchObject({ error: 'auth_required' })
    } finally {
      await local.stop()
    }
  })

  it.each([
    '?source=composio',
    '?limit=1&limit=2',
    '?cursor=11111111-1111-4111-8111-111111111111&cursor=22222222-2222-4222-8222-222222222222',
    '?limit=0',
    '?limit=101',
    '?limit=1.5',
    '?cursor=vendor-account-canary',
    '?cursor=11111111-1111-4111-8111-111111111111',
  ])('rejects malformed inventory query %s', async (query) => {
    const response = await fetch(`${gateway.baseUrl}/api/v1/connections${query}`, {
      headers: ownerHeaders(gateway),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'connection_list_invalid' })
  })
})

function ownerHeaders(gateway: TestGateway): Record<string, string> {
  return {
    Authorization: `Bearer ${gateway.token}`,
    'Content-Type': 'application/json',
  }
}

function seedConnections(gateway: TestGateway): void {
  const store = gateway.gateway.connectorConnections
  const entityId = InstallIdentity.resolve().id
  const seed = (
    connectionId: string,
    connectorId: string,
    initiatedAt: number,
    source: 'composio' | 'mcp' = 'composio',
    scopedEntityId: string = entityId,
  ) => store.upsertPending({
    connectionId,
    connectorId,
    source,
    entityId: scopedEntityId,
    initiatedAt,
    expiresAt: initiatedAt + 60_000,
    authConfigId: 'auth-config-canary',
    vendorAccountId: 'vendor-account-canary',
    vendorUserId: 'vendor-user-canary',
  })

  seed('pending-internal-canary', 'calendar', 9_000_000)

  seed('vendor-account-canary', 'mail', 8_000_000)
  store.markReady({ connectionId: 'vendor-account-canary', completedAt: 8_001_234 })
  store.touchVerified('vendor-account-canary', 8_002_345)

  seed('failed-internal-canary', 'crm', 7_000_000)
  store.markFailed({
    connectionId: 'failed-internal-canary',
    reason: 'raw-provider-error-canary',
    completedAt: 7_001_234,
  })

  seed('expired-internal-canary', 'storage', 6_000_000)
  store.markExpired('expired-internal-canary', 'raw-provider-error-canary')

  seed('unconfirmed-revoke-canary', 'billing', 5_000_000)
  store.markReady({ connectionId: 'unconfirmed-revoke-canary', completedAt: 5_001_234 })
  store.markRevoked(
    'unconfirmed-revoke-canary', 'raw-provider-error-canary', false,
  )

  seed('logical-key-canary', 'figma-c4vrjq3w', 4_000_000, 'mcp')
  store.markReady({ connectionId: 'logical-key-canary', completedAt: 4_001_234 })

  seed('older-failed-state', 'revoked-capability', 3_000_000)
  store.markFailed({ connectionId: 'older-failed-state', reason: 'failed' })
  seed('revoked-latest-state', 'revoked-capability', 3_100_000)
  store.markRevoked('revoked-latest-state', 'owner revoked')

  seed('foreign-row', 'install-identity-canary', 10_000_000, 'composio', 'foreign-entity')
}
