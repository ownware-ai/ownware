/**
 * /api/v1/health and /api/v1/app/version handler unit tests.
 *
 * Asserts the wire shape and — critically — that `version` /
 * `loomVersion` come from the package constants, not a hardcoded
 * literal. The client's Settings → About screen displays these; a hardcoded
 * "0.1.0" would lie about the deployed build.
 */

// Loom eagerly constructs provider clients at module load time.
if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LOOM_VERSION } from '@ownware/loom'
import { healthHandler, appVersionHandler } from '../../../src/gateway/handlers/health.js'
import { CORTEX_VERSION } from '../../../src/version.js'

interface CapturedResponse {
  status: number
  body: unknown
}

function mockReq(url: string): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(payload: string) {
      captured.body = JSON.parse(payload)
    },
  } as unknown as ServerResponse
  return { res, captured }
}

describe('GET /api/v1/health', () => {
  it('returns status ok with the cortex version from the package constant', async () => {
    const { res, captured } = mockRes()
    await healthHandler(mockReq('/api/v1/health'), res)

    expect(captured.status).toBe(200)
    const body = captured.body as { status: string; version: string; uptime: number }
    expect(body.status).toBe('ok')
    expect(body.version).toBe(CORTEX_VERSION)
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })
})

describe('GET /api/v1/app/version', () => {
  it('reports cortex and loom versions from the package constants, not hardcoded strings', async () => {
    const { res, captured } = mockRes()
    await appVersionHandler(mockReq('/api/v1/app/version'), res)

    expect(captured.status).toBe(200)
    const body = captured.body as {
      version: string
      loomVersion: string
      runtime: string
      platform: string
    }

    expect(body.version).toBe(CORTEX_VERSION)
    expect(body.loomVersion).toBe(LOOM_VERSION)
    // Sanity guard: never accidentally serve a placeholder.
    expect(body.version).not.toBe('')
    expect(body.loomVersion).not.toBe('')
    expect(body.runtime === 'bun' || body.runtime === 'node').toBe(true)
    expect(body.platform).toBe(process.platform)
  })
})
