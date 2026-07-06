/**
 * Integration-ish test: build the `web_search` Connector record via the
 * same path the registry uses. Verifies the enriched shape is valid
 * against `ConnectorSchema` (optional pluggable fields) and that
 * back-compat for M1 consumers holds (every required field still present).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from '../../../src/connector/credentials/vault.js'
import { WebSearchService } from '../../../src/connector/web-search/service.js'
import { buildWebSearchConnector } from '../../../src/connector/web-search/connector.js'
import { ConnectorSchema } from '../../../src/connector/schema.js'

describe('buildWebSearchConnector', () => {
  let tmpDir: string
  let vault: CredentialVault
  let service: WebSearchService
  const store = new Map<string, string>()
  const settings = {
    getSetting: (k: string) => { const v = store.get(k); return v === undefined ? undefined : { value: v } },
    setSetting: (k: string, v: string) => { store.set(k, v); return { value: v } },
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ws-c-'))
    vault = new CredentialVault(tmpDir)
    service = new WebSearchService({ settings, vault })
    store.clear()
    delete process.env['BRAVE_SEARCH_API_KEY']
    delete process.env['TAVILY_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('produces a valid Connector with pluggable fields populated', async () => {
    const c = await buildWebSearchConnector(service)
    expect(() => ConnectorSchema.parse(c)).not.toThrow()
    expect(c.id).toBe('web_search')
    expect(c.canonicalId).toBe('builtin:web_search')
    expect(c.source).toBe('builtin')
    expect(c.status).toBe('ready')
    expect(c.activeProviderId).toBe('duckduckgo')
    expect(c.defaultProviderId).toBe('duckduckgo')
    expect(c.activeProviderSource).toBe('default')
    expect(c.providers?.length).toBe(4)
    const ddg = c.providers!.find(p => p.id === 'duckduckgo')!
    expect(ddg.configured).toBe(true)
    const brave = c.providers!.find(p => p.id === 'brave')!
    expect(brave.configured).toBe(false)
    const pplx = c.providers!.find(p => p.id === 'perplexity-openrouter')!
    expect(pplx.configured).toBe(false)
  })

  it('marks brave as configured when env var is set', async () => {
    process.env['BRAVE_SEARCH_API_KEY'] = 'x'
    const c = await buildWebSearchConnector(service)
    expect(c.providers!.find(p => p.id === 'brave')!.configured).toBe(true)
    // Env causes auto-detect → active = brave.
    expect(c.activeProviderId).toBe('brave')
    expect(c.activeProviderSource).toBe('env')
  })

  it('M1 consumer reading only the base shape sees valid object', async () => {
    const c = await buildWebSearchConnector(service)
    // Simulate an M1 consumer that only knows the original shape: strip
    // the new optional fields and re-parse. Still valid.
    const { providers: _p, activeProviderId: _a, defaultProviderId: _d, activeProviderSource: _s, ...rest } = c
    void _p; void _a; void _d; void _s
    expect(() => ConnectorSchema.parse(rest)).not.toThrow()
  })
})
