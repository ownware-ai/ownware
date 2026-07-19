import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { setRequestPrincipal } from '../../../src/gateway/auth/scoped-principal.js'
import { createSearchSourceContentHandler } from '../../../src/gateway/handlers/source-content.js'
import {
  ProtectedSourceSearchError,
  type ProtectedSourceSearchService,
} from '../../../src/gateway/protected-source-search.js'

const RESOURCE_ID = '11111111-1111-4111-8111-111111111111'

describe('protected source-content HTTP mapping', () => {
  it('maps protected search timeout to a safe 504 without partial evidence', async () => {
    const search = vi.fn().mockRejectedValue(
      new ProtectedSourceSearchError('protected_source_search_timed_out'),
    )
    const handler = createSearchSourceContentHandler({ search } as unknown as ProtectedSourceSearchService)
    const req = request({
      consent: { state: 'not_required' },
      query: 'needle',
      matchMode: 'exact_utf8',
      maxMatches: 1,
      contextBytes: 0,
    })
    setRequestPrincipal(req, {
      kind: 'delegated',
      tokenId: '22222222-2222-4222-8222-222222222222',
      delegateId: 'source-search-timeout-proof',
      workspaceId: 'workspace.synthetic-1',
      profileId: 'profile.synthetic-1',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      operations: ['source_content.search'],
      issuedAt: 1,
      expiresAt: 9_999_999_999,
    })
    const res = response()

    await handler(req, res, { resourceId: RESOURCE_ID })

    expect(search).toHaveBeenCalledOnce()
    expect(search).toHaveBeenCalledWith({
      workspaceId: 'workspace.synthetic-1',
      profileId: 'profile.synthetic-1',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: RESOURCE_ID,
      consent: { state: 'not_required' },
      permissionMode: 'auto',
      query: 'needle',
      matchMode: 'exact_utf8',
      maxMatches: 1,
      contextBytes: 0,
    })
    expect(res.capture.status).toBe(504)
    expect(res.capture.headers.get('cache-control')).toBe('no-store')
    expect(res.capture.headers.get('x-ownware-correlation-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(res.capture.body).toEqual({
      error: 'source_content_search_timed_out',
      message: 'Protected source search timed out without returning partial results.',
      category: 'overload',
      correlationId: res.capture.headers.get('x-ownware-correlation-id'),
    })
    expect(JSON.stringify(res.capture.body)).not.toContain('matches')
    expect(JSON.stringify(res.capture.body)).not.toContain('needle')
  })
})

function request(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  ;(req as unknown as { headers: Record<string, string> }).headers = { host: 'localhost' }
  ;(req as unknown as { method: string }).method = 'POST'
  ;(req as unknown as { url: string }).url = `/api/v1/source-resources/${RESOURCE_ID}/search`
  return req
}

interface CapturedResponse extends ServerResponse {
  readonly capture: {
    readonly status: number
    readonly headers: ReadonlyMap<string, string>
    readonly body: unknown
  }
}

function response(): CapturedResponse {
  let status = 200
  let body: unknown
  const headers = new Map<string, string>()
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), String(value))
      return res
    },
    writeHead(nextStatus: number, nextHeaders?: OutgoingHttpHeaders) {
      status = nextStatus
      for (const [name, value] of Object.entries(nextHeaders ?? {})) {
        if (value !== undefined) headers.set(name.toLowerCase(), String(value))
      }
      return res
    },
    end(chunk?: string) {
      if (chunk !== undefined) body = JSON.parse(chunk)
      return res
    },
    get capture() { return { status, headers, body } },
  }
  return res as unknown as CapturedResponse
}
