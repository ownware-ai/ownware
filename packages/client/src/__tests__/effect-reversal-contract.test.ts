import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { OwnwareClient } from '../client.js'

describe('effect reversal public contract', () => {
  it('publishes capability-negotiated reads and exact execution without private targets', async () => {
    const [openapi, compatibility, readme, capabilities] = await Promise.all([
      readFile(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'),
      readFile(new URL('../../COMPATIBILITY.md', import.meta.url), 'utf8'),
      readFile(new URL('../../README.md', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../cortex/src/gateway/handlers/capabilities.ts', import.meta.url),
        'utf8',
      ),
    ])

    expect(typeof OwnwareClient.prototype.listEffectReversalOffers).toBe('function')
    expect(typeof OwnwareClient.prototype.executeEffectReversal).toBe('function')
    expect(typeof OwnwareClient.prototype.listEffectReversalReceipts).toBe('function')
    expect(capabilities).toContain("{ id: 'runs.reversals.read', version: 1 }")
    expect(capabilities).toContain("{ id: 'runs.reversals.execute', version: 1 }")
    expect(openapi).toContain('/api/v1/runs/{runId}/reversal-offers:')
    expect(openapi).toContain('operationId: executeEffectReversal')
    expect(openapi).toContain('/api/v1/runs/{runId}/reversal-receipts:')
    expect(openapi).toContain('EffectReversalExecutionResult:')
    expect(compatibility).toContain('| `0.45.0` | Exact registered effect adapters')
    expect(compatibility).toContain('this is not generic undo')
    expect(readme).toContain('`executeEffectReversal(runId, offerId, input)`')

    const offerSchema = openapi.slice(
      openapi.indexOf('    EffectReversalOffer:'),
      openapi.indexOf('    EffectReversalOfferPage:'),
    )
    for (const field of [
      'targetRef',
      'targetRevision',
      'targetProfileId',
      'targetThreadId',
      'proposedContent',
      'toolInput',
    ]) {
      expect(offerSchema).not.toContain(`\n        ${field}:`)
    }
  })

  it('sends bounded pages and the UUID retry identity on execution', async () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const offerId = '00000000-0000-4000-8000-000000000002'
    const key = '00000000-0000-4000-8000-000000000003'
    const effectId = '00000000-0000-4000-8000-000000000004'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/execute')) {
        return new Response(JSON.stringify({
          disposition: 'executed',
          offer: {
            offerId,
            sequence: 1,
            runId,
            effectId,
            toolCallId: 'call_1',
            toolName: 'memory.pending-proposal.create',
            adapterRef: 'memory.pending-proposal',
            adapterRevision: '1',
            operationKind: 'compensation',
            status: 'confirmed',
            createdAt: 1,
            expiresAt: null,
            resolvedAt: 2,
          },
          receipt: {
            receiptId: '00000000-0000-4000-8000-000000000005',
            sequence: 1,
            offerId,
            runId,
            effectId,
            operationKind: 'compensation',
            outcome: 'confirmed',
            authorityRef: 'memory.pending-proposal:1',
            actorKind: 'owner',
            observedAt: 2,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = new OwnwareClient({ baseUrl: 'http://127.0.0.1:3011', fetch: fetchMock })

    await client.listEffectReversalOffers(runId, { limit: 5, cursor: offerId })
    await client.executeEffectReversal(runId, offerId, { idempotencyKey: key })
    await client.listEffectReversalReceipts(runId, { limit: 10 })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:3011/api/v1/runs/${runId}/reversal-offers?limit=5&cursor=${offerId}`,
    )
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Idempotency-Key': key },
    })
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `http://127.0.0.1:3011/api/v1/runs/${runId}/reversal-receipts?limit=10`,
    )
  })
})
