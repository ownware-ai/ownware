/**
 * ComposioSourceProxy + ComposioToolProviderProxy — swap-at-runtime
 * contract. These proxies are how the gateway lets COMPOSIO_API_KEY
 * be added (or cleared) post-boot without restart; the connector
 * registry + session-runner reference the proxy once at boot and the
 * gateway swaps the inner on credential change.
 */

import { describe, expect, it, vi } from 'vitest'
import { ComposioSourceProxy } from '../../../../src/connector/composio/source-proxy.js'
import { ComposioToolProviderProxy } from '../../../../src/connector/composio/tool-provider-proxy.js'
import type { Connector } from '../../../../src/connector/schema.js'
import type { ConnectorSourceProvider } from '../../../../src/connector/registry.js'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderResult,
} from '../../../../src/connector/providers/types.js'
import type { LoadedProfile } from '../../../../src/profile/loader.js'

function fakeConnector(id: string): Connector {
  return {
    id,
    canonicalId: `composio:${id}`,
    name: id,
    description: '',
    source: 'composio',
    category: 'productivity',
    auth: { mode: 'oauth', provider: id, hasPreset: false },
    status: 'needs_setup',
    toolNames: null,
    iconUrl: null,
  } as Connector
}

describe('ComposioSourceProxy', () => {
  it('returns empty arrays when no inner is set', async () => {
    const proxy = new ComposioSourceProxy()
    expect(proxy.hasInner()).toBe(false)
    expect(await proxy.listGlobal()).toEqual([])
    expect(await proxy.listForProfile('any')).toEqual([])
  })

  it('delegates to the inner once set', async () => {
    const inner: ConnectorSourceProvider = {
      name: 'composio',
      listGlobal: vi.fn(async () => [fakeConnector('gmail')]),
      listForProfile: vi.fn(async () => [fakeConnector('slack')]),
    }
    const proxy = new ComposioSourceProxy()
    proxy.setInner(inner)
    expect(proxy.hasInner()).toBe(true)
    const global = await proxy.listGlobal()
    expect(global).toHaveLength(1)
    expect(global[0]!.id).toBe('gmail')
    const profile = await proxy.listForProfile('p1')
    expect(profile).toHaveLength(1)
    expect(profile[0]!.id).toBe('slack')
    expect(inner.listGlobal).toHaveBeenCalledTimes(1)
    expect(inner.listForProfile).toHaveBeenCalledTimes(1)
  })

  it('reverts to empty when inner is cleared', async () => {
    const proxy = new ComposioSourceProxy()
    proxy.setInner({
      name: 'composio',
      listGlobal: async () => [fakeConnector('gmail')],
      listForProfile: async () => [],
    })
    expect(await proxy.listGlobal()).toHaveLength(1)
    proxy.setInner(null)
    expect(proxy.hasInner()).toBe(false)
    expect(await proxy.listGlobal()).toEqual([])
  })

  it('hot-swaps inner without state on the proxy', async () => {
    // Regression guard: the credential-change rebuild calls setInner
    // with a fresh provider instance. The proxy MUST forward to the
    // new instance immediately — no cached results, no holdover.
    const first: ConnectorSourceProvider = {
      name: 'composio',
      listGlobal: async () => [fakeConnector('gmail')],
      listForProfile: async () => [],
    }
    const second: ConnectorSourceProvider = {
      name: 'composio',
      listGlobal: async () => [fakeConnector('notion'), fakeConnector('slack')],
      listForProfile: async () => [],
    }
    const proxy = new ComposioSourceProxy()
    proxy.setInner(first as never)
    expect((await proxy.listGlobal())[0]!.id).toBe('gmail')
    proxy.setInner(second as never)
    const list = await proxy.listGlobal()
    expect(list.map((c) => c.id).sort()).toEqual(['notion', 'slack'])
  })

  it('listPage returns an empty page when no inner is set', async () => {
    const proxy = new ComposioSourceProxy()
    const page = await proxy.listPage({ search: 'gmail', limit: 20 })
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('listPage delegates to inner with forwarded params', async () => {
    const received: Array<{ search?: string; cursor?: string; limit?: number }> = []
    const inner = {
      name: 'composio' as const,
      listGlobal: async () => [],
      listForProfile: async () => [],
      listPage: async (params: { search?: string; cursor?: string; limit?: number } = {}) => {
        received.push(params)
        return {
          items: [fakeConnector('gmail')],
          nextCursor: 'next-token',
        }
      },
    }
    const proxy = new ComposioSourceProxy()
    proxy.setInner(inner)
    const page = await proxy.listPage({ search: 'gma', limit: 5 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBe('next-token')
    expect(received).toEqual([{ search: 'gma', limit: 5 }])
  })
})

describe('ComposioToolProviderProxy', () => {
  const profile = { config: { tools: { composio: { toolkits: [] } } } } as unknown as LoadedProfile
  const ctx = { existingTools: [] as const }

  it('returns empty result when no inner is set', async () => {
    const proxy = new ComposioToolProviderProxy()
    expect(proxy.hasInner()).toBe(false)
    const r = await proxy.getToolsForProfile(profile, ctx)
    expect(r.tools).toEqual([])
    expect(r.stubs).toEqual([])
  })

  it('delegates to inner once set + reverts on clear', async () => {
    const fakeResult: ConnectorToolProviderResult = {
      tools: [],
      stubs: [],
    }
    const inner: ConnectorToolProvider = {
      source: 'composio',
      getToolsForProfile: vi.fn(async () => fakeResult),
    }
    const proxy = new ComposioToolProviderProxy()
    proxy.setInner(inner)
    expect(proxy.hasInner()).toBe(true)
    await proxy.getToolsForProfile(profile, ctx)
    expect(inner.getToolsForProfile).toHaveBeenCalledTimes(1)
    proxy.setInner(null)
    const r = await proxy.getToolsForProfile(profile, ctx)
    // Inner was cleared — call count stays at 1; result is the
    // proxy's empty fallback.
    expect(inner.getToolsForProfile).toHaveBeenCalledTimes(1)
    expect(r.tools).toEqual([])
    expect(r.stubs).toEqual([])
  })
})
