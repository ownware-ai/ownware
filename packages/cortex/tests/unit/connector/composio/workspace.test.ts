/**
 * Tests for `resolveComposioWorkspace` — precedence chain between env
 * overrides, live API fetch, and null fallback.
 */

import { describe, it, expect, vi } from 'vitest'
import { resolveComposioWorkspace } from '../../../../src/connector/composio/workspace.js'
import type { ComposioClient } from '../../../../src/connector/composio/client.js'

type StubClient = Pick<ComposioClient, 'getSessionInfo'>

function stubClient(impl: () => Promise<unknown>): StubClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { getSessionInfo: impl as any }
}

describe('resolveComposioWorkspace', () => {
  it('env override wins — skips API fetch entirely', async () => {
    const getSessionInfo = vi.fn(async () => { throw new Error('should not be called') })
    const res = await resolveComposioWorkspace({
      client: stubClient(getSessionInfo) as unknown as ComposioClient,
      envWorkspaceSlug: 'my_org',
      envProjectSlug: 'my_proj',
      warn: () => {},
    })
    expect(res?.dashboardBaseUrl).toBe('https://platform.composio.dev/my_org/my_proj')
    expect(getSessionInfo).not.toHaveBeenCalled()
  })

  it('only workspace env set → treated as not-set; falls through to API', async () => {
    const getSessionInfo = vi.fn(async () => ({
      project: { name: 'p', org: { name: 'o' } },
    }))
    const res = await resolveComposioWorkspace({
      client: stubClient(getSessionInfo) as unknown as ComposioClient,
      envWorkspaceSlug: 'only_ws',
      envProjectSlug: '',
      warn: () => {},
    })
    expect(res?.dashboardBaseUrl).toBe('https://platform.composio.dev/o/p')
    expect(getSessionInfo).toHaveBeenCalledOnce()
  })

  it('only project env set → treated as not-set; falls through to API', async () => {
    const getSessionInfo = vi.fn(async () => ({
      project: { name: 'p', org: { name: 'o' } },
    }))
    const res = await resolveComposioWorkspace({
      client: stubClient(getSessionInfo) as unknown as ComposioClient,
      envWorkspaceSlug: undefined,
      envProjectSlug: 'only_proj',
      warn: () => {},
    })
    expect(res?.dashboardBaseUrl).toBe('https://platform.composio.dev/o/p')
    expect(getSessionInfo).toHaveBeenCalledOnce()
  })

  it('env both whitespace-only → treated as not-set', async () => {
    const getSessionInfo = vi.fn(async () => ({
      project: { name: 'p', org: { name: 'o' } },
    }))
    const res = await resolveComposioWorkspace({
      client: stubClient(getSessionInfo) as unknown as ComposioClient,
      envWorkspaceSlug: '   ',
      envProjectSlug: '   ',
      warn: () => {},
    })
    expect(res?.dashboardBaseUrl).toBe('https://platform.composio.dev/o/p')
  })

  it('API success → builds dashboard base URL', async () => {
    const warn = vi.fn()
    const res = await resolveComposioWorkspace({
      client: stubClient(async () => ({
        project: { name: 'acme_first', org: { name: 'acme_org' } },
      })) as unknown as ComposioClient,
      warn,
    })
    expect(res?.dashboardBaseUrl).toBe(
      'https://platform.composio.dev/acme_org/acme_first',
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('API throws → returns null + one warn line', async () => {
    const warn = vi.fn()
    const res = await resolveComposioWorkspace({
      client: stubClient(async () => { throw new Error('401 unauthorized') }) as unknown as ComposioClient,
      warn,
    })
    expect(res).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toMatch(/workspace/i)
  })

  it('URL-encodes slugs with special characters', async () => {
    const res = await resolveComposioWorkspace({
      client: stubClient(async () => ({
        project: { name: 'proj with space', org: { name: 'org/weird' } },
      })) as unknown as ComposioClient,
      warn: () => {},
    })
    expect(res?.dashboardBaseUrl).toBe(
      'https://platform.composio.dev/org%2Fweird/proj%20with%20space',
    )
  })

  it('env override URL-encodes slugs', async () => {
    const res = await resolveComposioWorkspace({
      client: stubClient(async () => ({
        project: { name: 'x', org: { name: 'y' } },
      })) as unknown as ComposioClient,
      envWorkspaceSlug: 'a b',
      envProjectSlug: 'c/d',
      warn: () => {},
    })
    expect(res?.dashboardBaseUrl).toBe('https://platform.composio.dev/a%20b/c%2Fd')
  })

  it('empty slug in API response → warn + null', async () => {
    const warn = vi.fn()
    const res = await resolveComposioWorkspace({
      client: stubClient(async () => ({
        project: { name: '   ', org: { name: 'o' } },
      })) as unknown as ComposioClient,
      warn,
    })
    // Zod enforces min(1) so the passthrough above actually hits Zod's
    // validation inside the real client. Here we go through the resolver
    // which uses the raw client stub — the empty-slug guard below catches.
    expect(res).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })
})
