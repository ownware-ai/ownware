/**
 * Tests for `createModelCatalogHandler`.
 *
 * The factory takes `listConfiguredProviders` and uses its return value
 * as the source of truth for the per-model `hasCredentials` flag.
 * Server wires it to the unified credentials store so the answer
 * reflects encrypted DB rows, not `process.env`.
 */

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createModelCatalogHandler } from '../../../src/gateway/handlers/catalog.js'
import { ALL_MODELS } from '../../../src/gateway/catalog/models/index.js'
import type { ModelInfo } from '../../../src/gateway/types.js'

interface CapturedResponse {
  status?: number
  body?: ModelInfo[]
}

function fakeRes(captured: CapturedResponse): ServerResponse {
  // Minimal ServerResponse shim — only the fields `sendJSON` touches.
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v },
    writeHead(code: number) {
      captured.status = code
      this.statusCode = code
    },
    end(body?: string) {
      captured.status ??= this.statusCode
      if (body) captured.body = JSON.parse(body) as ModelInfo[]
    },
    write() { /* noop */ },
  } as unknown as ServerResponse
  return res
}

const fakeReq = {} as unknown as IncomingMessage

async function callHandler(configured: readonly string[]): Promise<ModelInfo[]> {
  const captured: CapturedResponse = {}
  const handler = createModelCatalogHandler({
    listConfiguredProviders: async () => configured,
  })
  await handler(fakeReq, fakeRes(captured))
  return captured.body ?? []
}

describe('createModelCatalogHandler — hasCredentials from DB-shaped list', () => {
  it('returns hasCredentials=true ONLY for providers in the configured list', async () => {
    const models = await callHandler(['openrouter'])
    const orModels = models.filter((m) => m.provider === 'openrouter')
    const otherModels = models.filter((m) => m.provider !== 'openrouter')
    expect(orModels.length).toBeGreaterThan(0)
    for (const m of orModels) expect(m.hasCredentials).toBe(true)
    for (const m of otherModels) expect(m.hasCredentials).toBe(false)
  })

  it('treats an empty configured list as "no providers connected"', async () => {
    const models = await callHandler([])
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) expect(m.hasCredentials).toBe(false)
  })

  it('flags every provider when all are configured', async () => {
    // 'ollama' counts as configured via reachability (keyless local
    // provider) — include it so "all configured" covers the full catalog.
    const models = await callHandler(['anthropic', 'openai', 'google', 'openrouter', 'ollama'])
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) expect(m.hasCredentials).toBe(true)
  })

  it('returns the full curated catalog (no models dropped)', async () => {
    const models = await callHandler([])
    expect(models.length).toBe(ALL_MODELS.length)
    // Spot-check the IDs match our catalog so future renames break this test.
    const ids = new Set(models.map((m) => m.id))
    for (const m of ALL_MODELS) expect(ids.has(m.id)).toBe(true)
  })

  it('does NOT consult process.env — placeholder strings in env do not flip hasCredentials', async () => {
    const prevAnth = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-dev-placeholder'
    try {
      const models = await callHandler([]) // configured list is empty
      const anth = models.filter((m) => m.provider === 'anthropic')
      for (const m of anth) expect(m.hasCredentials).toBe(false)
    } finally {
      if (prevAnth === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prevAnth
    }
  })
})
