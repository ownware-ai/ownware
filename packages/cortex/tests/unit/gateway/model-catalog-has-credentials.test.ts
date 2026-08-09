/** The legacy model route is a wire-only projection of Provider Hub. */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createModelCatalogHandler } from '../../../src/gateway/handlers/catalog.js'
import type { ProviderHubCompatibilityModel } from '../../../src/provider-hub/index.js'

interface CapturedResponse {
  status?: number
  body?: ProviderHubCompatibilityModel[]
  headers: Record<string, string>
}

function fakeRes(captured: CapturedResponse): ServerResponse {
  return {
    statusCode: 200,
    setHeader(k: string, v: string) { captured.headers[k] = v },
    writeHead(code: number) {
      captured.status = code
      this.statusCode = code
    },
    end(body?: string) {
      captured.status ??= this.statusCode
      if (body) captured.body = JSON.parse(body) as ProviderHubCompatibilityModel[]
    },
    write() { /* noop */ },
  } as unknown as ServerResponse
}

const fixture: ProviderHubCompatibilityModel = {
  id: 'openai:gpt-fixture',
  name: 'GPT Fixture',
  provider: 'openai',
  tier: 'balanced',
  description: 'Fixture projected by Provider Hub.',
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  costPer1kInput: 0.001,
  costPer1kOutput: 0.002,
  capabilities: ['streaming'],
  aliases: [],
  releaseDate: '2026-08-09',
  default: true,
  hasCredentials: true,
}

describe('createModelCatalogHandler — Provider Hub compatibility projection', () => {
  it('returns the Hub projection unchanged and marks the old route deprecated', async () => {
    let calls = 0
    const captured: CapturedResponse = { headers: {} }
    const handler = createModelCatalogHandler({
      compatibilityModels: async () => {
        calls += 1
        return [fixture]
      },
    })

    await handler({} as IncomingMessage, fakeRes(captured))

    expect(calls).toBe(1)
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual([fixture])
    expect(captured.headers).toMatchObject({
      Deprecation: 'true',
      Link: '</api/v1/provider-hub/models>; rel="successor-version"',
    })
  })
})
