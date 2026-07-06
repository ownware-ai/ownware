import { describe, it, expect } from 'vitest'
import { ComposioToolProviderProxy } from '../../../../src/connector/composio/tool-provider-proxy.js'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderResult,
} from '../../../../src/connector/providers/types.js'
import type { LoadedProfile } from '../../../../src/profile/loader.js'

function profileWithToolkits(toolkits: readonly string[]): LoadedProfile {
  return {
    config: { tools: { composio: { toolkits } } },
  } as unknown as LoadedProfile
}

const CTX = { existingTools: [] }

describe('ComposioToolProviderProxy — keyless (inner=null)', () => {
  it('returns an empty result for profiles with no declared toolkits', async () => {
    const proxy = new ComposioToolProviderProxy()
    const result = await proxy.getToolsForProfile(profileWithToolkits([]), CTX)
    expect(result.tools).toEqual([])
    expect(result.stubs).toEqual([])
  })

  it('emits one actionable stub per declared toolkit instead of silence', async () => {
    const proxy = new ComposioToolProviderProxy()
    const result = await proxy.getToolsForProfile(
      profileWithToolkits(['github', 'notion']),
      CTX,
    )
    expect(result.tools).toEqual([])
    expect(result.stubs).toHaveLength(2)
    const names = result.stubs.map((s) => s.name)
    expect(names).toEqual(['composio_github_unavailable', 'composio_notion_unavailable'])
    for (const stub of result.stubs) {
      // The description tells the user exactly what is missing.
      expect(stub.description).toContain('COMPOSIO_API_KEY')
    }
  })

  it('stub execution returns the connector_not_ready payload with the fix instruction', async () => {
    const proxy = new ComposioToolProviderProxy()
    const { stubs } = await proxy.getToolsForProfile(profileWithToolkits(['github']), CTX)
    const result = await stubs[0]!.execute({}, { signal: new AbortController().signal } as never)
    expect(result.isError).toBe(true)
    // Human-readable line for the transcript…
    expect(String(result.content)).toContain('COMPOSIO_API_KEY')
    // …typed payload for clients.
    const payload = result.metadata as { kind: string; reason: string }
    expect(payload.kind).toBe('connector_not_ready')
    expect(payload.reason).toContain('COMPOSIO_API_KEY')
    expect(payload.reason).toContain('composio.dev')
  })
})

describe('ComposioToolProviderProxy — wired (inner set)', () => {
  it('delegates to the inner provider untouched', async () => {
    const proxy = new ComposioToolProviderProxy()
    const innerResult: ConnectorToolProviderResult = {
      tools: [],
      stubs: [],
      configOverlay: { marker: true },
    }
    const inner: ConnectorToolProvider = {
      source: 'composio',
      getToolsForProfile: async () => innerResult,
    }
    proxy.setInner(inner)
    const result = await proxy.getToolsForProfile(profileWithToolkits(['github']), CTX)
    expect(result).toBe(innerResult)
  })
})
