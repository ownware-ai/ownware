/**
 * Tests for the pure source resolver.
 */

import { describe, it, expect } from 'vitest'

import { resolveSourceForLogicalKey } from '../../../src/connector/source-resolver.js'
import type { Connector, ConnectorSource } from '../../../src/connector/schema.js'

function mk(source: ConnectorSource, id: string, status: Connector['status'] = 'ready'): Connector {
  return {
    id,
    canonicalId: `${source}:${id}`,
    name: id,
    description: `${id} connector`,
    source,
    category: source === 'mcp' ? 'mcp' : 'other',
    auth: { mode: 'none' },
    status,
    toolNames: null,
  }
}

describe('resolveSourceForLogicalKey — precedence', () => {
  it('1. user choice wins when the chosen source is present and not errored', () => {
    const mcp = mk('mcp', 'notion', 'ready')
    const composio = mk('composio', 'notion', 'ready')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio], 'composio')
    expect(winner?.source).toBe('composio')
  })

  it('1a. user choice is honoured even when the chosen source is needs_setup', () => {
    const mcp = mk('mcp', 'notion', 'ready')
    const composio = mk('composio', 'notion', 'needs_setup')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio], 'composio')
    expect(winner?.source).toBe('composio')
    expect(winner?.status).toBe('needs_setup')
  })

  it('1b. user choice is IGNORED when the chosen source is in error', () => {
    // User explicitly chose mcp; mcp is in error → fall through to the
    // next-best (Composio ready, which is the new default winner).
    const mcp = mk('mcp', 'notion', 'error')
    const composio = mk('composio', 'notion', 'ready')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio], 'mcp')
    expect(winner?.source).toBe('composio')
  })

  it('1b-bis. F4.c-2: user choice is IGNORED when the chosen source is auth_error', () => {
    // `auth_error` is terminal-broken just like `error` — the user
    // must reauthorize before the connector is usable again. Pre-F4.c-2
    // the resolver only filtered out `error` and would happily return
    // an `auth_error` connector, leaving the agent with a known-dead
    // connection. Post-F4.c-2 both terminal failures fall through to
    // the next-best ready alternative.
    const mcp = mk('mcp', 'notion', 'auth_error')
    const composio = mk('composio', 'notion', 'ready')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio], 'mcp')
    expect(winner?.source).toBe('composio')
  })

  it('1b-ter. F4.c-2: user choice IS honoured when the chosen source is stale', () => {
    // `stale` is transient — the reconciler is already retrying. The
    // user picked this source explicitly, so we keep honouring the
    // choice rather than re-routing them to a different vendor just
    // because the last reachability probe missed.
    const mcp = mk('mcp', 'notion', 'ready')
    const composio = mk('composio', 'notion', 'stale')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio], 'composio')
    expect(winner?.source).toBe('composio')
    expect(winner?.status).toBe('stale')
  })

  it('1c. user choice for an absent source falls through to default winner', () => {
    const mcp = mk('mcp', 'notion', 'ready')
    const winner = resolveSourceForLogicalKey('notion', [mcp], 'composio')
    // Composio not present → MCP is the only ready candidate.
    expect(winner?.source).toBe('mcp')
  })

  it('2. no user choice + Composio ready → Composio wins even if MCP is also ready', () => {
    const mcp = mk('mcp', 'notion', 'ready')
    const composio = mk('composio', 'notion', 'ready')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio])
    expect(winner?.source).toBe('composio')
  })

  it('3. only MCP ready → MCP wins', () => {
    const mcp = mk('mcp', 'notion', 'ready')
    const composio = mk('composio', 'notion', 'needs_setup')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio])
    expect(winner?.source).toBe('mcp')
  })

  it('4. neither mcp nor composio ready but a builtin is → builtin wins (any ready)', () => {
    const mcp = mk('mcp', 'notion', 'needs_setup')
    const builtin = mk('builtin', 'notion', 'ready')
    const winner = resolveSourceForLogicalKey('notion', [mcp, builtin])
    expect(winner?.source).toBe('builtin')
  })

  it('5. cold-start — no one ready, mcp + composio present → composio wins (default winner)', () => {
    const mcp = mk('mcp', 'notion', 'needs_setup')
    const composio = mk('composio', 'notion', 'needs_setup')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio])
    expect(winner?.source).toBe('composio')
  })

  it('5a. cold-start — no one ready, no composio → first in deterministic order wins', () => {
    const mcp = mk('mcp', 'notion', 'needs_setup')
    const builtin = mk('builtin', 'notion', 'error')
    const winner = resolveSourceForLogicalKey('notion', [builtin, mcp])
    // deterministic: mcp before builtin (composio not present)
    expect(winner?.source).toBe('mcp')
  })

  it('6. empty candidate list → null', () => {
    expect(resolveSourceForLogicalKey('notion', [])).toBeNull()
  })

  it('resolver is deterministic regardless of input order', () => {
    const mcp = mk('mcp', 'notion', 'ready')
    const composio = mk('composio', 'notion', 'ready')
    const a = resolveSourceForLogicalKey('notion', [composio, mcp])
    const b = resolveSourceForLogicalKey('notion', [mcp, composio])
    expect(a?.source).toBe('composio')
    expect(b?.source).toBe('composio')
  })

  it('userChoice empty string is treated as absent', () => {
    const mcp = mk('mcp', 'notion', 'ready')
    const composio = mk('composio', 'notion', 'ready')
    const winner = resolveSourceForLogicalKey('notion', [mcp, composio], '')
    expect(winner?.source).toBe('composio')
  })

  it('single-candidate sets always return that candidate', () => {
    const only = mk('composio', 'gmail', 'needs_setup')
    const winner = resolveSourceForLogicalKey('gmail', [only])
    expect(winner).toBe(only)
  })
})
