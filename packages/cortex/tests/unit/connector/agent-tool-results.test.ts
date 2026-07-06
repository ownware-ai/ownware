/**
 * Connector agent-tool result schemas — Phase 5-C tests.
 *
 * Exercises every result type's parse/reject contract and the
 * `connectorToCard` projection. The polymorphic union is verified
 * by parsing each variant through the discriminated schema.
 */

import { describe, it, expect } from 'vitest'
import {
  ConnectorAgentToolResultSchema,
  ConnectorAttachedListResultSchema,
  ConnectorCardSchema,
  ConnectorStatusResultSchema,
  connectorToCard,
} from '../../../src/connector/agent-tool-results.js'
import type { Connector } from '../../../src/connector/schema.js'

const FULL_CONNECTOR: Connector = {
  id: 'github',
  canonicalId: 'mcp:github',
  logicalKey: 'github',
  name: 'GitHub',
  description: 'Repos, issues, PRs.',
  source: 'mcp',
  category: 'dev-tools',
  auth: { mode: 'oauth', provider: 'GitHub', hasPreset: true },
  status: 'needs_setup',
  toolNames: null,
  iconUrl: 'https://avatars.githubusercontent.com/github',
  availableModes: ['token', 'oauth'],
  tokenInputs: [
    {
      name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      description: 'GitHub PAT',
      isRequired: true,
      isSecret: true,
    },
  ],
  oauthPreset: {
    registerUrl: 'https://github.com/settings/developers',
    scopes: ['repo'],
  },
  suggestedPrompts: ['Show open PRs across my repos'],
}

describe('connectorToCard', () => {
  it('projects every card field from a full Connector', () => {
    const card = connectorToCard(FULL_CONNECTOR)
    expect(card).toEqual({
      id: 'github',
      canonicalId: 'mcp:github',
      name: 'GitHub',
      description: 'Repos, issues, PRs.',
      iconUrl: 'https://avatars.githubusercontent.com/github',
      source: 'mcp',
      category: 'dev-tools',
      status: 'needs_setup',
      availableModes: ['token', 'oauth'],
    })
  })

  it('omits iconUrl when undefined on the source connector', () => {
    const noIcon: Connector = { ...FULL_CONNECTOR, iconUrl: undefined }
    const card = connectorToCard(noIcon)
    expect('iconUrl' in card).toBe(false)
  })

  it('preserves a null iconUrl (lobby renders letter tile)', () => {
    const nulled: Connector = { ...FULL_CONNECTOR, iconUrl: null }
    const card = connectorToCard(nulled)
    expect(card.iconUrl).toBeNull()
  })

  it('omits availableModes for non-connectable connectors', () => {
    const builtin: Connector = {
      id: 'read_file',
      canonicalId: 'builtin:read_file',
      logicalKey: 'read_file',
      name: 'read_file',
      description: '',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: ['read_file'],
    }
    const card = connectorToCard(builtin)
    expect('availableModes' in card).toBe(false)
  })

  it('produces a card that round-trips through ConnectorCardSchema', () => {
    const card = connectorToCard(FULL_CONNECTOR)
    expect(() => ConnectorCardSchema.parse(card)).not.toThrow()
  })
})

// ConnectorSearchResultSchema retired 2026-05-16 (slice G) with the
// agent-tool `search` action and the `/tools` lobby. Tests for it
// removed in the same change. See agent-tool-results.ts header.

describe('ConnectorAttachedListResultSchema', () => {
  it('accepts an attached entry with connectedAt + toolCount', () => {
    const parsed = ConnectorAttachedListResultSchema.parse({
      type: 'connector_attached_list',
      items: [
        {
          ...connectorToCard(FULL_CONNECTOR),
          connectedAt: '2026-05-06T12:00:00.000Z',
          toolCount: 12,
        },
      ],
    })
    expect(parsed.items[0]?.connectedAt).toBe('2026-05-06T12:00:00.000Z')
    expect(parsed.items[0]?.toolCount).toBe(12)
  })

  it('rejects an entry missing connectedAt', () => {
    expect(() =>
      ConnectorAttachedListResultSchema.parse({
        type: 'connector_attached_list',
        items: [{ ...connectorToCard(FULL_CONNECTOR), toolCount: 5 }],
      }),
    ).toThrow()
  })
})

describe('ConnectorStatusResultSchema', () => {
  it('accepts a connected status with metadata', () => {
    const parsed = ConnectorStatusResultSchema.parse({
      type: 'connector_status',
      id: 'github',
      canonicalId: 'mcp:github',
      name: 'GitHub',
      status: 'ready',
      lastUsed: '2026-05-06T12:00:00.000Z',
      toolCount: 12,
    })
    expect(parsed.status).toBe('ready')
  })

  it('accepts an error status with diagnostic message', () => {
    const parsed = ConnectorStatusResultSchema.parse({
      type: 'connector_status',
      id: 'github',
      canonicalId: 'mcp:github',
      name: 'GitHub',
      status: 'error',
      error: '401 Unauthorized — token expired',
    })
    expect(parsed.error).toContain('401')
  })

  it('accepts a needs_setup status with no metadata', () => {
    const parsed = ConnectorStatusResultSchema.parse({
      type: 'connector_status',
      id: 'github',
      canonicalId: 'mcp:github',
      name: 'GitHub',
      status: 'needs_setup',
    })
    expect(parsed.status).toBe('needs_setup')
  })
})

describe('ConnectorAgentToolResultSchema (discriminated union)', () => {
  it('rejects the retired connector_search_result type', () => {
    // Retired 2026-05-16 alongside the `/tools` lobby. Chat history
    // hydrated with a pre-rip payload should fail safeParse and the
    // chat card gracefully no-ops (the agent's text content still
    // renders normally).
    const result = ConnectorAgentToolResultSchema.safeParse({
      type: 'connector_search_result',
      query: 'gmail',
      items: [],
      totalAvailable: 0,
      suggestions: [],
    })
    expect(result.success).toBe(false)
  })

  it('routes to ConnectorAttachedListResult on type=connector_attached_list', () => {
    const parsed = ConnectorAgentToolResultSchema.parse({
      type: 'connector_attached_list',
      items: [],
    })
    if (parsed.type !== 'connector_attached_list') {
      throw new Error('discriminator routed to the wrong branch')
    }
    expect(parsed.items.length).toBe(0)
  })

  it('routes to ConnectorStatusResult on type=connector_status', () => {
    const parsed = ConnectorAgentToolResultSchema.parse({
      type: 'connector_status',
      id: 'gh',
      canonicalId: 'mcp:gh',
      name: 'GitHub',
      status: 'ready',
    })
    if (parsed.type !== 'connector_status') {
      throw new Error('discriminator routed to the wrong branch')
    }
    expect(parsed.status).toBe('ready')
  })

  it('rejects an unknown type literal', () => {
    expect(() =>
      ConnectorAgentToolResultSchema.parse({
        type: 'connector_foo_bar',
        items: [],
      }),
    ).toThrow()
  })
})
