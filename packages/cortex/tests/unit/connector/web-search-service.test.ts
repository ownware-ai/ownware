/**
 * Unit tests for WebSearchService — the impure wrapper over the resolver.
 *
 * Uses an in-memory settings stub and a temp-dir vault so each test is
 * isolated and no disk state persists.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from '../../../src/connector/credentials/vault.js'
import {
  WebSearchService,
  WEB_SEARCH_SETTING_KEY,
  __resetWebSearchStartupLogForTests,
} from '../../../src/connector/web-search/service.js'
import { vaultIdFor } from '../../../src/connector/web-search/providers.js'
import { z } from 'zod'
import { ConnectorNotReadyErrorSchema } from '../../../src/connector/schema.js'

class InMemSettings {
  private readonly store = new Map<string, string>()
  getSetting(k: string) {
    const v = this.store.get(k)
    return v === undefined ? undefined : { value: v }
  }
  setSetting(k: string, v: string) { this.store.set(k, v); return { value: v } }
}

describe('WebSearchService', () => {
  let tmpDir: string
  let vault: CredentialVault
  let settings: InMemSettings
  let service: WebSearchService

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ws-svc-'))
    vault = new CredentialVault(tmpDir)
    settings = new InMemSettings()
    service = new WebSearchService({ settings, vault })
    __resetWebSearchStartupLogForTests()
    // Clear env so tests are deterministic. OPENROUTER_API_KEY is now
    // also a search-provider trigger (perplexity-openrouter), so it has
    // to be cleared too — otherwise local `.env` leaks in.
    delete process.env['BRAVE_SEARCH_API_KEY']
    delete process.env['TAVILY_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves to duckduckgo by default', async () => {
    const r = await service.resolve()
    expect(r.providerId).toBe('duckduckgo')
    expect(r.source).toBe('default')
    expect(r.status).toBe('ready')
  })

  it('persists user choice', () => {
    service.setUserChoice('brave')
    expect(settings.getSetting(WEB_SEARCH_SETTING_KEY)?.value).toBe('brave')
  })

  it('rejects unknown provider id on setUserChoice', () => {
    expect(() => service.setUserChoice('foo')).toThrow(/Unknown/)
  })

  it('saveApiKey persists into vault and subsequently resolves with it', async () => {
    await service.saveApiKey('brave', 'secret-key')
    service.setUserChoice('brave')
    const r = await service.resolve()
    expect(r.providerId).toBe('brave')
    expect(r.source).toBe('user')
    expect(r.apiKey).toBe('secret-key')
  })

  it('saveApiKey rejects key-free provider', async () => {
    await expect(service.saveApiKey('duckduckgo', 'x')).rejects.toThrow(/does not accept/)
  })

  it('saveApiKey rejects empty key', async () => {
    await expect(service.saveApiKey('brave', '')).rejects.toThrow(/non-empty/)
  })

  it('env var is picked up by auto-detect when no user choice', async () => {
    process.env['BRAVE_SEARCH_API_KEY'] = 'env-bk'
    const r = await service.resolve()
    expect(r.providerId).toBe('brave')
    expect(r.source).toBe('env')
    expect(r.apiKey).toBe('env-bk')
  })

  it('buildStrategy maps ids to strategies', () => {
    expect(service.buildStrategy('duckduckgo').id).toBe('duckduckgo')
    expect(service.buildStrategy('brave').id).toBe('brave')
    expect(service.buildStrategy('tavily').id).toBe('tavily')
    expect(service.buildStrategy('perplexity-openrouter').id).toBe('perplexity-openrouter')
    expect(() => service.buildStrategy('unknown')).toThrow()
  })

  it('OPENROUTER_API_KEY is picked up as perplexity-openrouter via env', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test'
    const r = await service.resolve()
    expect(r.providerId).toBe('perplexity-openrouter')
    expect(r.source).toBe('env')
    expect(r.apiKey).toBe('sk-or-test')
  })

  it('Brave key still wins over OpenRouter (dedicated search key beats multi-purpose key)', async () => {
    process.env['BRAVE_SEARCH_API_KEY'] = 'env-bk'
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test'
    const r = await service.resolve()
    expect(r.providerId).toBe('brave')
    expect(r.source).toBe('env')
  })

  it('vault id for reserved pattern', () => {
    expect(vaultIdFor('brave')).toBe('builtin:web_search:brave')
  })

  it('ConnectorNotReadyError schema accepts enriched (pluggable) metadata', () => {
    const payload = {
      kind: 'connector_not_ready' as const,
      connectorId: 'web_search',
      connectorName: 'Web Search',
      source: 'builtin' as const,
      authMode: { mode: 'none' as const },
      reason: 'No provider configured',
      at: new Date().toISOString(),
      providerId: 'brave',
      providerName: 'Brave Search',
      availableProviders: [
        {
          id: 'duckduckgo',
          name: 'DuckDuckGo',
          description: 'key-free',
          auth: { mode: 'none' as const },
          homepage: 'https://duckduckgo.com',
          isDefault: true,
          configured: true,
        },
      ],
    }
    expect(() => ConnectorNotReadyErrorSchema.parse(payload)).not.toThrow()
  })

  it('ConnectorNotReadyError schema still accepts M1 (non-pluggable) shape', () => {
    // Bare shape without pluggable fields must still validate — this is
    // the M1 regression gate.
    const payload = {
      kind: 'connector_not_ready' as const,
      connectorId: 'some-mcp-server',
      connectorName: 'Some MCP',
      source: 'mcp' as const,
      authMode: { mode: 'none' as const },
      reason: 'Server unreachable',
      at: new Date().toISOString(),
    }
    expect(() => ConnectorNotReadyErrorSchema.parse(payload)).not.toThrow()
  })

  it('rejects malformed metadata', () => {
    expect(() =>
      ConnectorNotReadyErrorSchema.parse({ kind: 'other' }),
    ).toThrow(z.ZodError)
  })
})
