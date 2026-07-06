/**
 * Contract: surviving MCP endpoints (post-T21)
 *
 * POST   /api/v1/profiles/:profileId/mcp           — attach to profile
 * DELETE /api/v1/profiles/:profileId/mcp/:serverId — detach
 *
 * The READ surfaces — GET /api/v1/mcp/servers, /mcp/featured,
 * /mcp/marketplace, /mcp/marketplace/:id, /profiles/:id/mcp — were
 * retired in T21. The client reads all of those through the unified
 * /api/v1/connectors and /api/v1/catalog endpoints. The gateway-state
 * helpers (`listMCPServers` etc.) survive — they're consumed by the
 * connector registry and tested below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Contract: MCP', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({
      seed: (state) => {
        state.createMCPServer({ id: 'contract-srv-1', name: 'Server One', transport: 'stdio' })
        state.createMCPServer({ id: 'contract-srv-2', name: 'Server Two', transport: 'sse' })
        state.assignServerToProfile('contract-srv-1', 'mini')
      },
    })
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('listMCPServers returns profileIds without N+1', () => {
    const result = gw.state.listMCPServers()
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    const srv1 = result.items.find(s => s.id === 'contract-srv-1')
    expect(srv1).toBeDefined()
    expect(Array.isArray(srv1!.profileIds)).toBe(true)
    expect(srv1!.profileIds).toContain('mini')
  })

  it('listMCPServers honors pagination', () => {
    const r1 = gw.state.listMCPServers({ limit: 1, offset: 0 })
    const r2 = gw.state.listMCPServers({ limit: 1, offset: 1 })
    expect(r1.items.length).toBe(1)
    expect(r2.items.length).toBe(1)
    expect(r1.total).toBeGreaterThanOrEqual(2)
  })
})
