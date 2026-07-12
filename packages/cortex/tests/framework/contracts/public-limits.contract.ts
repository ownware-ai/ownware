import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'

let gateway: TestGateway

beforeEach(async () => {
  gateway = await createTestGateway()
})

afterEach(async () => {
  await gateway.stop()
})

describe('public request limits contract', () => {
  it('returns a typed 413 before mutation when JSON exceeds 10 MiB', async () => {
    const before = gateway.state.listThreads(undefined, { limit: 10_000 }).items.length
    const response = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ profileId: 'mini', prompt: 'x'.repeat(10 * 1024 * 1024) }),
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('x-ownware-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
    await expect(response.json()).resolves.toMatchObject({
      error: 'payload_too_large',
      category: 'invalid_request',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      limitBytes: 10 * 1024 * 1024,
    })
    expect(gateway.state.listThreads(undefined, { limit: 10_000 }).items).toHaveLength(before)
  })
})
