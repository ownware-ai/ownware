import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_ITEM_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
} from '@ownware/loom'

describe('Contract: bounded ephemeral run attachments', () => {
  let gateway: TestGateway

  beforeEach(async () => {
    gateway = await createTestGateway({ disableAuth: false })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  const post = (attachments: unknown[]) => fetch(`${gateway.baseUrl}/api/v1/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ profileId: 'mini', prompt: 'inspect the attached data', attachments }),
  })

  it('rejects malformed/spoofed attachments before thread or run mutation', async () => {
    const before = gateway.state.listThreads().total
    for (const attachment of [
      { filename: 'bad.txt', mimeType: 'text/plain', data: '%%%%' },
      { filename: 'secret-canary.pdf', mimeType: 'application/pdf', data: Buffer.from('RAW-CANARY').toString('base64') },
    ]) {
      const response = await post([attachment])
      expect(response.status).toBe(400)
      const raw = await response.text()
      expect(JSON.parse(raw)).toMatchObject({ error: 'attachment_invalid' })
      expect(raw).not.toContain('secret-canary')
      expect(raw).not.toContain('RAW-CANARY')
    }
    expect(gateway.state.listThreads().total).toBe(before)
  })

  it('rejects count and decoded item overflow before mutation', async () => {
    const before = gateway.state.listThreads().total
    const tiny = { filename: 'x.txt', mimeType: 'text/plain', data: Buffer.from('x').toString('base64') }
    const count = await post(Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, () => tiny))
    expect(count.status).toBe(400)
    await expect(count.json()).resolves.toMatchObject({ error: 'attachment_invalid' })
    const tooLarge = {
      filename: 'large.txt', mimeType: 'text/plain',
      data: Buffer.alloc(ATTACHMENT_MAX_ITEM_BYTES + 1, 120).toString('base64'),
    }
    const item = await post([tooLarge])
    expect(item.status).toBe(400)
    await expect(item.json()).resolves.toMatchObject({ error: 'attachment_invalid' })
    const half = Math.floor(ATTACHMENT_MAX_TOTAL_BYTES / 2) + 1
    const aggregate = await post([
      { filename: 'one.txt', mimeType: 'text/plain', data: Buffer.alloc(half, 120).toString('base64') },
      { filename: 'two.txt', mimeType: 'text/plain', data: Buffer.alloc(half, 121).toString('base64') },
    ])
    expect(aggregate.status).toBe(400)
    await expect(aggregate.json()).resolves.toMatchObject({
      error: 'attachment_invalid', reason: 'total_too_large',
    })
    expect(gateway.state.listThreads().total).toBe(before)
  })

  it('requires the separate delegated attachment operation and accepts bounded data when granted', async () => {
    const workspace = gateway.state.createWorkspace(gateway.tmpDir, 'Attachment contract')
    const issue = async (delegateId: string, operations: string[]) => {
      const response = await gateway.client.post('/api/v1/auth/delegations', {
        delegateId,
        workspaceId: workspace.id,
        profileId: 'mini',
        purpose: 'bounded-ephemeral-context',
        operations,
      })
      return (response.body as { token: string }).token
    }
    const attachment = {
      filename: 'note.txt', mimeType: 'text/plain',
      data: Buffer.from('UNTRUSTED-CONTENT').toString('base64'),
    }
    const run = (token: string, key: string) => fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        profileId: 'mini',
        prompt: 'inspect',
        attachments: [attachment],
      }),
    })

    const deniedToken = await issue('run-only', ['runs.start'])
    const denied = await run(deniedToken, '11111111-aaaa-4111-8111-111111111111')
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: 'principal_operation_denied' })

    const allowedToken = await issue('run-with-attachment', ['runs.start', 'runs.attachments'])
    const allowed = await run(allowedToken, '22222222-bbbb-4222-8222-222222222222')
    expect(allowed.status).toBe(200)
    await expect(allowed.json()).resolves.toMatchObject({ profileId: 'mini', status: 'running' })
  })

})
