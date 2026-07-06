import { describe, it, expect } from 'vitest'
import {
  ConnectorSchema,
  ConnectorListSchema,
  ConnectorNotReadyErrorSchema,
  ConnectorsQuerySchema,
  AuthModeSchema,
  ConnectorSourceSchema,
  ConnectorStatusSchema,
} from '../../../src/connector/schema.js'

describe('Connector schema', () => {
  it('accepts a valid builtin connector', () => {
    const c = ConnectorSchema.parse({
      id: 'readFile',
      canonicalId: 'builtin:readFile',
      logicalKey: 'readFile',
      name: 'Read File',
      description: 'Read a file from disk',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: ['readFile'],
    })
    expect(c.source).toBe('builtin')
    expect(c.auth.mode).toBe('none')
    expect(c.canonicalId).toBe('builtin:readFile')
    expect(c.actions).toBeUndefined()
  })

  it('1.5a/D2: accepts optional `actions` for grouped builtin cards', () => {
    const c = ConnectorSchema.parse({
      id: 'browser',
      canonicalId: 'builtin:browser',
      logicalKey: 'browser',
      name: 'Browser',
      description: 'Navigate, click, screenshot.',
      source: 'builtin',
      category: 'browser',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: ['browser_click', 'browser_type'],
      actions: [
        { name: 'browser_click', description: 'Click a DOM element.' },
        { name: 'browser_type', description: 'Type into a DOM element.' },
      ],
    })
    expect(c.actions!.length).toBe(2)
    expect(c.actions![0]!.name).toBe('browser_click')
  })

  it('1.5a/D2: rejects actions with empty name', () => {
    const bad = {
      id: 'browser', canonicalId: 'builtin:browser', name: 'Browser',
      description: '', source: 'builtin', category: 'browser',
      auth: { mode: 'none' }, status: 'ready', toolNames: null,
      actions: [{ name: '', description: 'x' }],
    }
    expect(() => ConnectorSchema.parse(bad)).toThrow()
  })

  it('accepts a valid MCP connector with api_key auth', () => {
    const c = ConnectorSchema.parse({
      id: 'io.github.user/weather',
      canonicalId: 'mcp:io.github.user/weather',
      logicalKey: 'io.github.user/weather',
      name: 'Weather',
      description: 'Weather lookup',
      source: 'mcp',
      category: 'productivity',
      auth: {
        mode: 'api_key',
        envVars: [
          { name: 'WEATHER_API_KEY', description: 'API key', isRequired: true, isSecret: true },
        ],
      },
      status: 'needs_setup',
      toolNames: null,
    })
    expect(c.status).toBe('needs_setup')
    if (c.auth.mode !== 'api_key') throw new Error('expected api_key')
    expect(c.auth.envVars[0]!.name).toBe('WEATHER_API_KEY')
  })

  it('accepts oauth auth', () => {
    const auth = AuthModeSchema.parse({ mode: 'oauth', provider: 'Notion', hasPreset: true })
    if (auth.mode !== 'oauth') throw new Error('expected oauth')
    expect(auth.provider).toBe('Notion')
  })

  it('rejects unknown source', () => {
    expect(() => ConnectorSourceSchema.parse('bogus')).toThrow()
  })

  it('rejects unknown status', () => {
    expect(() => ConnectorStatusSchema.parse('connecting')).toThrow()
  })

  // F4.c-1 (2026-05-16): status taxonomy extended from 3 → 5 values.
  // The wire enum split a single `error` into `stale` (transient,
  // auto-retries) and `auth_error` (vendor revoked, user must
  // reauthorize). Pre-existing three values keep their canonical
  // positions for back-compat.
  it('accepts the F4.c stale status', () => {
    expect(ConnectorStatusSchema.parse('stale')).toBe('stale')
  })

  it('accepts the F4.c auth_error status', () => {
    expect(ConnectorStatusSchema.parse('auth_error')).toBe('auth_error')
  })

  it('lists every status in the canonical wire order', () => {
    // Wire order is append-only — never reorder the first three
    // values. Any client-side mirror of this schema MUST list in
    // the same order. A drift triggers this test (parsing the
    // canonical list via the schema preserves order via z.enum).
    const canonical = ConnectorStatusSchema.options
    expect(canonical).toEqual(['ready', 'stale', 'needs_setup', 'auth_error', 'error'])
  })

  it('accepts an ISO lastVerifiedAt on connectors', () => {
    const c = ConnectorSchema.parse({
      id: 'gmail',
      canonicalId: 'composio:gmail',
      logicalKey: 'gmail',
      name: 'Gmail',
      description: 'Send and read mail',
      source: 'composio',
      category: 'communication',
      auth: { mode: 'oauth', provider: 'Google', hasPreset: false },
      status: 'ready',
      toolNames: null,
      lastVerifiedAt: '2026-05-16T12:00:00.000Z',
    })
    expect(c.lastVerifiedAt).toBe('2026-05-16T12:00:00.000Z')
  })

  it('rejects non-ISO lastVerifiedAt', () => {
    // Defensive: free-form strings would silently break the client's
    // "Last checked Xm ago" rendering.
    expect(() => ConnectorSchema.parse({
      id: 'gmail',
      canonicalId: 'composio:gmail',
      logicalKey: 'gmail',
      name: 'Gmail',
      description: '',
      source: 'composio',
      category: 'communication',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: null,
      lastVerifiedAt: 'just now',
    })).toThrow()
  })

  it('omits lastVerifiedAt for never-verified connectors', () => {
    const c = ConnectorSchema.parse({
      id: 'readFile',
      canonicalId: 'builtin:readFile',
      logicalKey: 'readFile',
      name: 'Read File',
      description: '',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: ['readFile'],
    })
    expect(c.lastVerifiedAt).toBeUndefined()
  })

  it('rejects connector missing required fields', () => {
    expect(() => ConnectorSchema.parse({ id: 'x' })).toThrow()
  })

  it('rejects empty id', () => {
    expect(() => ConnectorSchema.parse({
      id: '',
      canonicalId: 'builtin:x',
      logicalKey: 'x',
      name: 'x',
      description: '',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: null,
    })).toThrow()
  })

  it('rejects malformed canonicalId (missing source prefix)', () => {
    expect(() => ConnectorSchema.parse({
      id: 'readFile',
      canonicalId: 'readFile',
      name: 'Read File',
      description: '',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: null,
    })).toThrow()
  })

  it('accepts optional iconUrl (absolute URL)', () => {
    const c = ConnectorSchema.parse({
      id: 'notion',
      canonicalId: 'composio:notion',
      logicalKey: 'notion',
      name: 'Notion',
      description: '',
      source: 'composio',
      category: 'productivity',
      auth: { mode: 'oauth', provider: 'Notion', hasPreset: false },
      status: 'needs_setup',
      toolNames: null,
      iconUrl: 'https://cdn.example.com/logos/notion.png',
    })
    expect(c.iconUrl).toBe('https://cdn.example.com/logos/notion.png')
  })

  it('accepts explicit null iconUrl', () => {
    const c = ConnectorSchema.parse({
      id: 'x',
      canonicalId: 'builtin:x',
      logicalKey: 'x',
      name: 'x',
      description: '',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: null,
      iconUrl: null,
    })
    expect(c.iconUrl).toBeNull()
  })

  it('accepts a connector with no iconUrl field (backward compat)', () => {
    const c = ConnectorSchema.parse({
      id: 'x',
      canonicalId: 'builtin:x',
      logicalKey: 'x',
      name: 'x',
      description: '',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: null,
    })
    expect(c.iconUrl).toBeUndefined()
  })

  it('rejects iconUrl that is not a URL', () => {
    expect(() => ConnectorSchema.parse({
      id: 'x',
      canonicalId: 'builtin:x',
      logicalKey: 'x',
      name: 'x',
      description: '',
      source: 'builtin',
      category: 'filesystem',
      auth: { mode: 'none' },
      status: 'ready',
      toolNames: null,
      iconUrl: 'not a url',
    })).toThrow()
  })

  it('ConnectorListSchema validates an array', () => {
    const list = ConnectorListSchema.parse([])
    expect(list).toEqual([])
  })
})

describe('ConnectorNotReadyError', () => {
  it('accepts a well-formed payload', () => {
    const err = ConnectorNotReadyErrorSchema.parse({
      kind: 'connector_not_ready',
      connectorId: 'notion',
      connectorName: 'Notion',
      source: 'mcp',
      authMode: { mode: 'oauth', provider: 'Notion', hasPreset: true },
      reason: 'Credentials not configured',
      at: new Date().toISOString(),
    })
    expect(err.kind).toBe('connector_not_ready')
  })

  it('rejects a payload with wrong kind', () => {
    expect(() => ConnectorNotReadyErrorSchema.parse({
      kind: 'other',
      connectorId: 'x',
      connectorName: 'x',
      source: 'mcp',
      authMode: { mode: 'none' },
      reason: 'r',
      at: new Date().toISOString(),
    })).toThrow()
  })

  it('rejects empty reason', () => {
    expect(() => ConnectorNotReadyErrorSchema.parse({
      kind: 'connector_not_ready',
      connectorId: 'x',
      connectorName: 'x',
      source: 'mcp',
      authMode: { mode: 'none' },
      reason: '',
      at: new Date().toISOString(),
    })).toThrow()
  })
})

describe('ConnectorsQuerySchema', () => {
  it('accepts empty query', () => {
    expect(ConnectorsQuerySchema.parse({})).toEqual({})
  })

  it('accepts profileId', () => {
    expect(ConnectorsQuerySchema.parse({ profileId: 'my-agent' })).toEqual({ profileId: 'my-agent' })
  })

  it('rejects empty profileId', () => {
    expect(() => ConnectorsQuerySchema.parse({ profileId: '' })).toThrow()
  })
})
