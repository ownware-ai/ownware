/**
 * Tests for GET /api/v1/connectors/sources/status (Session 1.5a / D5).
 *
 * Exercises the handler directly with fake IncomingMessage / ServerResponse
 * objects. The endpoint reports per-source enable/disable state so the client
 * can render section-level empty-state hints (most notably the Composio
 * section when `COMPOSIO_API_KEY` is not set).
 */

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createSourcesStatusHandler,
  ConnectorSourcesStatusSchema,
} from '../../../src/gateway/handlers/connector-sources-status.js'
import type { WebSearchService } from '../../../src/connector/web-search/service.js'

interface Captured { status: number; body: unknown }

function mockReq(): IncomingMessage {
  return { url: '/api/v1/connectors/sources/status', headers: { host: 'localhost' } } as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null }
  const res = {
    writeHead(s: number) { captured.status = s; return this },
    end(p: string) { captured.body = JSON.parse(p) },
  } as unknown as ServerResponse
  return { res, captured }
}

function fakeService(providerId: string): WebSearchService {
  return {
    resolve: async () => ({
      providerId,
      provider: { id: providerId, name: providerId, description: '', auth: { mode: 'none' } },
      source: 'default',
      status: 'ready',
      reason: null,
    }),
  } as unknown as WebSearchService
}

describe('GET /api/v1/connectors/sources/status', () => {
  it('reports composio=disabled with reason when the source is disabled', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: false,
      webSearchService: fakeService('duckduckgo'),
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    expect(captured.status).toBe(200)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.builtin.status).toBe('enabled')
    expect(parsed.mcp.status).toBe('enabled')
    expect(parsed.composio.status).toBe('disabled')
    expect(parsed.composio.reason).toBe('COMPOSIO_API_KEY not set')
    expect(parsed.web_search.activeProvider).toBe('duckduckgo')
  })

  it('reports composio=enabled when the source is configured', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: true,
      webSearchService: fakeService('duckduckgo'),
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    expect(captured.status).toBe(200)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.composio.status).toBe('enabled')
    expect(parsed.composio.reason).toBeUndefined()
  })

  it('includes featuredCount + totalCount when enabled + counters provided', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: true,
      webSearchService: fakeService('duckduckgo'),
      getComposioFeaturedCount: () => 19,
      getComposioTotalCount: () => 1027,
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    expect(captured.status).toBe(200)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.composio.status).toBe('enabled')
    expect(parsed.composio.featuredCount).toBe(19)
    expect(parsed.composio.totalCount).toBe(1027)
  })

  it('omits counts when counter callbacks are absent', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: true,
      webSearchService: fakeService('duckduckgo'),
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.composio.featuredCount).toBeUndefined()
    expect(parsed.composio.totalCount).toBeUndefined()
  })

  it('includes dashboardBaseUrl when resolver returns a URL', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: true,
      webSearchService: fakeService('duckduckgo'),
      getComposioDashboardBaseUrl: () => 'https://platform.composio.dev/org_x/proj_y',
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.composio.status).toBe('enabled')
    expect(parsed.composio.dashboardBaseUrl).toBe(
      'https://platform.composio.dev/org_x/proj_y',
    )
  })

  it('omits dashboardBaseUrl when resolver returns undefined', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: true,
      webSearchService: fakeService('duckduckgo'),
      getComposioDashboardBaseUrl: () => undefined,
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.composio.dashboardBaseUrl).toBeUndefined()
  })

  it('omits dashboardBaseUrl on disabled composio even if resolver callback is set', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: false,
      webSearchService: fakeService('duckduckgo'),
      getComposioDashboardBaseUrl: () => 'https://platform.composio.dev/should/not/leak',
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.composio.status).toBe('disabled')
    expect(parsed.composio.dashboardBaseUrl).toBeUndefined()
  })

  it('custom composioDisabledReason is surfaced verbatim', async () => {
    const handler = createSourcesStatusHandler({
      isComposioEnabled: false,
      composioDisabledReason: 'Invalid vault entry',
      webSearchService: fakeService('brave'),
    })
    const { res, captured } = mockRes()
    await handler(mockReq(), res)
    const parsed = ConnectorSourcesStatusSchema.parse(captured.body)
    expect(parsed.composio.reason).toBe('Invalid vault entry')
    expect(parsed.web_search.activeProvider).toBe('brave')
  })
})
