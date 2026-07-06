/**
 * Unit tests for the MCP register handler's dedup logic.
 *
 * Two passes verified:
 *   1. Endpoint dedup — same transport + URL/command → return existing.
 *   2. LogicalKey dedup — different endpoint, same logical app
 *      (e.g. user typed "Figma" while an auto-detected Figma row exists).
 *
 * Uses a minimal fake `GatewayState` so the test runs without sqlite —
 * the integration test (`tests/integration/gateway/mcp-register.test.ts`)
 * exercises the same code through the real DB.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import { createMCPRegisterHandlers } from '../../../src/gateway/handlers/mcp-register.js'
import {
  CUSTOM_MCP_REGISTRY_MARKER,
  DETECTED_REGISTRY_MARKER,
} from '../../../src/connector/schema.js'

interface FakeRow {
  id: string
  name: string
  transport: string
  registryId: string
  command?: string | null
  args?: readonly string[] | null
  url?: string | null
  headers?: Record<string, string> | null
}

function makeReq(body: unknown): IncomingMessage {
  // Minimal IncomingMessage built from a Readable stream.
  // readJSON in router.ts uses Buffer.concat on the chunks, so chunks
  // must be Buffer instances, not strings.
  const stream = Readable.from([Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    url: '/api/v1/mcp/register',
  }) as unknown as IncomingMessage
}

function makeRes(): {
  res: ServerResponse
  body: { status: number; payload: unknown }
} {
  const body: { status: number; payload: unknown } = { status: 0, payload: null }
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (data?: string) => {
      body.status = (res as unknown as { statusCode: number }).statusCode
      body.payload = data ? JSON.parse(data) : null
    },
    writeHead(status: number) {
      ;(res as unknown as { statusCode: number }).statusCode = status
      return res
    },
  } as unknown as ServerResponse
  return { res, body }
}

function makeState(rows: FakeRow[]): {
  state: Parameters<typeof createMCPRegisterHandlers>[0]['state']
  inserted: FakeRow[]
} {
  const inserted: FakeRow[] = []
  const state = {
    listMCPServers: () => ({ items: rows.map(r => ({ ...r })) }),
    getMCPServer: (id: string) =>
      rows.find(r => r.id === id) ?? inserted.find(r => r.id === id),
    createMCPServer: (row: FakeRow) => {
      inserted.push(row)
      return row
    },
  } as unknown as Parameters<typeof createMCPRegisterHandlers>[0]['state']
  return { state, inserted }
}

const fakeVault = {
  delete: async () => undefined,
} as unknown as Parameters<typeof createMCPRegisterHandlers>[0]['vault']

describe('POST /api/v1/mcp/register — dedup', () => {
  describe('endpoint dedup (existing behaviour)', () => {
    it('returns existing custom row when same http URL is registered again', async () => {
      const { state } = makeState([
        {
          id: 'figma-c4vrjq3w',
          name: 'Figma',
          transport: 'http',
          registryId: CUSTOM_MCP_REGISTRY_MARKER,
          url: 'https://mcp.figma.com/mcp',
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'Figma Different Name',
          transport: 'http',
          url: 'https://mcp.figma.com/mcp',
        }),
        res,
      )
      expect(body.status).toBe(200)
      const payload = body.payload as { id: string; dedupedBy?: string }
      expect(payload.id).toBe('figma-c4vrjq3w')
      expect(payload.dedupedBy).toBe('endpoint')
    })

    it('returns existing custom row when same stdio command+args is registered again', async () => {
      const { state } = makeState([
        {
          id: 'paper-2abcdefg',
          name: 'Paper',
          transport: 'stdio',
          registryId: CUSTOM_MCP_REGISTRY_MARKER,
          command: '/usr/local/bin/paper-mcp',
          args: ['--mode', 'serve'],
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'Paper',
          transport: 'stdio',
          command: '/usr/local/bin/paper-mcp',
          args: ['--mode', 'serve'],
        }),
        res,
      )
      expect(body.status).toBe(200)
      expect((body.payload as { id: string }).id).toBe('paper-2abcdefg')
    })
  })

  describe('logicalKey dedup (the new "kill 3 Figma rows" behaviour)', () => {
    it('returns existing custom row when name kebab matches another custom row logicalKey', async () => {
      // Existing: figma-c4vrjq3w (logicalKey = 'figma' after suffix strip)
      // Trying to register: name="Figma", different URL → should dedup.
      const { state, inserted } = makeState([
        {
          id: 'figma-c4vrjq3w',
          name: 'Figma',
          transport: 'http',
          registryId: CUSTOM_MCP_REGISTRY_MARKER,
          url: 'https://mcp.figma.com/mcp',
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'Figma',
          transport: 'http',
          url: 'https://different-figma-endpoint.example.com/mcp',
        }),
        res,
      )
      expect(body.status).toBe(200)
      const payload = body.payload as { id: string; dedupedBy?: string }
      expect(payload.id).toBe('figma-c4vrjq3w')
      expect(payload.dedupedBy).toBe('logicalKey')
      expect(inserted.length).toBe(0) // no new row created
    })

    it('returns existing detected row when name matches its logicalKey', async () => {
      // Auto-detect created `figma` (no suffix because known-apps.json
      // gave us the canonical id directly). User then opens Add Custom MCP
      // and types "Figma" with their own URL → should not duplicate.
      const { state, inserted } = makeState([
        {
          id: 'figma',
          name: 'Figma',
          transport: 'http',
          registryId: DETECTED_REGISTRY_MARKER,
          url: 'https://mcp.figma.com/mcp',
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'Figma',
          transport: 'stdio',
          command: '/some/local/figma-mcp-script',
        }),
        res,
      )
      expect(body.status).toBe(200)
      expect((body.payload as { id: string }).id).toBe('figma')
      expect(inserted.length).toBe(0)
    })

    it('inserts a new row when no logicalKey collision exists', async () => {
      // Existing: figma. User registers paper → genuinely new app.
      const { state, inserted } = makeState([
        {
          id: 'figma',
          name: 'Figma',
          transport: 'http',
          registryId: DETECTED_REGISTRY_MARKER,
          url: 'https://mcp.figma.com/mcp',
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'Paper',
          transport: 'stdio',
          command: '/usr/local/bin/paper-mcp',
        }),
        res,
      )
      expect(body.status).toBe(201)
      expect(inserted.length).toBe(1)
      const newRow = inserted[0]!
      expect(newRow.name).toBe('Paper')
      expect(newRow.id.startsWith('paper-')).toBe(true)
    })

    it('case-insensitive: "FIGMA" and "figma" both kebab to the same logicalKey', async () => {
      const { state, inserted } = makeState([
        {
          id: 'figma',
          name: 'Figma',
          transport: 'http',
          registryId: DETECTED_REGISTRY_MARKER,
          url: 'https://mcp.figma.com/mcp',
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'FIGMA',
          transport: 'stdio',
          command: '/some/path',
        }),
        res,
      )
      expect(body.status).toBe(200)
      expect(inserted.length).toBe(0)
    })

    it('whitespace and special chars in name normalise to same logicalKey', async () => {
      const { state, inserted } = makeState([
        {
          id: 'my-tool',
          name: 'My Tool',
          transport: 'stdio',
          registryId: CUSTOM_MCP_REGISTRY_MARKER,
          command: '/path/a',
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'My  Tool!',
          transport: 'stdio',
          command: '/path/b',
        }),
        res,
      )
      expect(body.status).toBe(200)
      expect((body.payload as { id: string }).id).toBe('my-tool')
      expect(inserted.length).toBe(0)
    })
  })

  describe('regression guards', () => {
    it('different logicalKey → genuinely new row', async () => {
      const { state, inserted } = makeState([])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'Brand New Server',
          transport: 'stdio',
          command: '/path',
        }),
        res,
      )
      expect(body.status).toBe(201)
      expect(inserted.length).toBe(1)
    })

    it('featured (registry_id != custom/detected) rows are NOT considered for dedup', async () => {
      // Featured rows live in the curated catalog, not mcp_servers; if one
      // ever ends up in mcp_servers with a non-custom registry_id, it
      // should not block a custom registration.
      const { state, inserted } = makeState([
        {
          id: 'figma',
          name: 'Figma',
          transport: 'http',
          registryId: 'featured-mcp-figma', // some non-custom marker
          url: 'https://mcp.figma.com/mcp',
        },
      ])
      const handlers = createMCPRegisterHandlers({ state, vault: fakeVault })
      const { res, body } = makeRes()
      await handlers.registerServer(
        makeReq({
          name: 'Figma',
          transport: 'http',
          url: 'https://my-figma.example.com/mcp',
        }),
        res,
      )
      // Inserts a new row because the existing one is not custom/detected.
      expect(body.status).toBe(201)
      expect(inserted.length).toBe(1)
    })
  })
})
