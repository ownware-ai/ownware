/**
 * Invariant tests — a custom MCP that declared env / header names at
 * register time must NEVER hydrate to `status: 'ready'` while its
 * credential vault is empty. This pins down Phase 16-bis: pre-fix,
 * `mcpRowToConnector` defaulted to `auth.mode: 'none'` whenever
 * neither the featured catalog nor known-apps recognised the server,
 * which propagated to `'ready'` via `computeConnectorStatus`. The
 * card lied that no credentials were needed.
 *
 * These tests exercise the row → Connector path directly with a
 * stubbed credential vault, so the assertion is on the pure
 * derivation logic, not the live SQLite layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub the credential vault BEFORE importing registry — registry
// reaches into the real vault by side-effect import. The stub returns
// "no env var is set" for every check, simulating a freshly-registered
// custom MCP whose user hasn't entered credentials yet.
vi.mock('../../../src/connector/credentials/vault.js', () => ({
  credentialVault: {
    checkEnvVars: vi.fn(async (_id: string, names: readonly string[]) => {
      const out: Record<string, boolean> = {}
      for (const n of names) out[n] = false
      return out
    }),
    load: vi.fn(async () => null),
  },
}))

// describeMCPServer hits the remote registry by default — short-circuit
// to "unknown" so the row's own declared names are the only source.
vi.mock('../../../src/connector/mcp/registry.js', () => ({
  getRegistryEntry: vi.fn(async () => null),
  fetchMCPRegistry: vi.fn(async () => []),
}))

import { mcpRowToConnector } from '../../../src/connector/registry.js'

beforeEach(() => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
})
afterEach(() => {
  delete process.env['OWNWARE_SKIP_MCP_REGISTRY']
})

describe('mcpRowToConnector — custom MCP status invariant', () => {
  it('stdio with declared env names + empty vault → needs_setup, not ready', async () => {
    const c = await mcpRowToConnector({
      id: 'my-custom-fs',
      name: 'my custom fs',
      transport: 'stdio',
      registryId: 'custom',
      env: { API_KEY: '${API_KEY}', BASE_URL: '${BASE_URL}' },
      headers: null,
    })
    expect(c.auth.mode).toBe('api_key')
    if (c.auth.mode !== 'api_key') return
    expect(c.auth.envVars.map(v => v.name)).toEqual(['API_KEY', 'BASE_URL'])
    expect(c.status).toBe('needs_setup')
  })

  it('http with declared header names + empty vault → needs_setup, not ready', async () => {
    const c = await mcpRowToConnector({
      id: 'my-custom-http',
      name: 'my custom http',
      transport: 'http',
      registryId: 'custom',
      env: null,
      headers: { Authorization: '', 'X-Tenant': '' },
    })
    expect(c.auth.mode).toBe('api_key')
    if (c.auth.mode !== 'api_key') return
    expect(c.auth.envVars.map(v => v.name)).toEqual(['Authorization', 'X-Tenant'])
    expect(c.status).toBe('needs_setup')
  })

  it('stdio with no declared env → auth.mode: none, status: needs_setup (unattached default)', async () => {
    // A custom MCP that genuinely needs no env / headers is still
    // shown as `needs_setup` in the unattached catalog view — the
    // user hasn't picked a profile yet. Once attached, it'll go
    // through `mcpServerToConnector` where `none` flips to ready.
    const c = await mcpRowToConnector({
      id: 'my-zero-auth',
      name: 'my zero auth',
      transport: 'stdio',
      registryId: 'custom',
      env: {},
      headers: null,
    })
    expect(c.auth.mode).toBe('none')
    expect(c.status).toBe('needs_setup')
  })

  it('http with no declared headers → auth.mode: none, status: needs_setup (unattached default)', async () => {
    const c = await mcpRowToConnector({
      id: 'my-zero-auth-http',
      name: 'my zero auth http',
      transport: 'http',
      registryId: 'custom',
      env: null,
      headers: {},
    })
    expect(c.auth.mode).toBe('none')
    expect(c.status).toBe('needs_setup')
  })

  it('pre-migration-026 row (env field null) is handled like empty env', async () => {
    // Rows written before migration 026 have `env: null` in the DB
    // and `null` in the structural reader. Must not throw and must
    // not silently mark the server ready.
    const c = await mcpRowToConnector({
      id: 'legacy-row',
      name: 'legacy row',
      transport: 'stdio',
      registryId: 'custom',
      // env explicitly omitted to mirror pre-migration shape
      headers: null,
    })
    expect(c.auth.mode).toBe('none')
    expect(c.status).toBe('needs_setup')
  })
})

describe('mcpRowToConnector — required env var shape', () => {
  it('synthesised envVars are required + secret by default', async () => {
    const c = await mcpRowToConnector({
      id: 'my-fs',
      name: 'my fs',
      transport: 'stdio',
      registryId: 'custom',
      env: { TOKEN: '${TOKEN}' },
      headers: null,
    })
    expect(c.auth.mode).toBe('api_key')
    if (c.auth.mode !== 'api_key') return
    expect(c.auth.envVars).toHaveLength(1)
    expect(c.auth.envVars[0]).toMatchObject({
      name: 'TOKEN',
      isRequired: true,
      isSecret: true,
    })
  })
})
