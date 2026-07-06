/**
 * Unit tests for `gateway/sync-mcp-servers.ts:reconcileMCPServers`.
 *
 * The pure function is the boot reconcile that keeps `mcp_servers` +
 * `profile_mcp_servers` in sync with `agent.json` declarations. Tests
 * use a fake state adapter so we exercise the logic without sqlite.
 */

import { describe, it, expect } from 'vitest'

import {
  reconcileMCPServers,
  type ProfileForSync,
  type SyncMCPServersStateAdapter,
  type MCPServerRecordForSync,
} from '../../../src/gateway/sync-mcp-servers.js'

// ---------------------------------------------------------------------------
// Fake state adapter
// ---------------------------------------------------------------------------

interface FakeServer {
  id: string
  registryId: string | null
}

interface FakeAssignment {
  serverId: string
  profileId: string
}

function makeFakeState(initial: {
  servers?: FakeServer[]
  assignments?: FakeAssignment[]
} = {}) {
  const servers = new Map<string, FakeServer>(
    (initial.servers ?? []).map(s => [s.id, { ...s }]),
  )
  const assignments: FakeAssignment[] = (initial.assignments ?? []).map(a => ({
    ...a,
  }))

  const adapter: SyncMCPServersStateAdapter = {
    getMCPServer(id) {
      return servers.get(id)
    },
    createMCPServer(server) {
      servers.set(server.id, { id: server.id, registryId: null })
      return { id: server.id }
    },
    assignServerToProfile(serverId, profileId) {
      // Idempotent: don't double-add the same pair.
      if (
        !assignments.some(
          a => a.serverId === serverId && a.profileId === profileId,
        )
      ) {
        assignments.push({ serverId, profileId })
      }
    },
    removeServerFromProfile(serverId, profileId) {
      const idx = assignments.findIndex(
        a => a.serverId === serverId && a.profileId === profileId,
      )
      if (idx === -1) return false
      assignments.splice(idx, 1)
      return true
    },
    getServersForProfile(profileId) {
      const ids = assignments
        .filter(a => a.profileId === profileId)
        .map(a => a.serverId)
      const out: MCPServerRecordForSync[] = []
      for (const id of ids) {
        const s = servers.get(id)
        if (s) out.push({ id: s.id, registryId: s.registryId })
      }
      return out
    },
    listMCPServers() {
      return {
        items: [...servers.values()].map(s => ({
          id: s.id,
          registryId: s.registryId,
        })),
      }
    },
    deleteMCPServer(id) {
      const had = servers.has(id)
      servers.delete(id)
      // Cascade: drop assignments that pointed at it.
      for (let i = assignments.length - 1; i >= 0; i--) {
        if (assignments[i]!.serverId === id) assignments.splice(i, 1)
      }
      return had
    },
  }

  return { adapter, servers, assignments }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profile(id: string, mcp: Record<string, { transport: string; url?: string; command?: string }>): ProfileForSync {
  return { id, mcp }
}

const STDIO = { transport: 'stdio', command: 'echo' }
const HTTP = (url: string) => ({ transport: 'http', url })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcileMCPServers — Phase 1 (forward sync)', () => {
  it('creates a server row + assignment for a fresh profile', () => {
    const { adapter, servers, assignments } = makeFakeState()
    const result = reconcileMCPServers(
      [profile('coder', { 'paper': STDIO })],
      adapter,
    )
    expect(servers.has('paper')).toBe(true)
    expect(assignments).toEqual([{ serverId: 'paper', profileId: 'coder' }])
    expect(result.createdServers).toBe(1)
    expect(result.addedAssignments).toBe(1)
    expect(result.removedAssignments).toBe(0)
    expect(result.removedOrphanedServers).toBe(0)
  })

  it('does not duplicate when the row already exists', () => {
    const { adapter, servers, assignments } = makeFakeState({
      servers: [{ id: 'paper', registryId: null }],
    })
    const result = reconcileMCPServers(
      [profile('coder', { 'paper': STDIO })],
      adapter,
    )
    expect(result.createdServers).toBe(0)
    expect(servers.size).toBe(1)
    expect(assignments.length).toBe(1)
  })

  it('handles streamable_http → http transport mapping', () => {
    const { adapter, servers } = makeFakeState()
    reconcileMCPServers(
      [profile('coder', { 'foo': { transport: 'streamable_http', url: 'https://x/y' } })],
      adapter,
    )
    expect(servers.get('foo')).toBeDefined()
  })

  it('skips profiles whose mcp is null (load failure sentinel)', () => {
    const { adapter, servers, assignments } = makeFakeState({
      assignments: [{ serverId: 'paper', profileId: 'coder' }],
      servers: [{ id: 'paper', registryId: null }],
    })
    const result = reconcileMCPServers(
      [{ id: 'coder', mcp: null }],
      adapter,
    )
    // mcp:null means "couldn't read" → don't drop existing assignments.
    expect(assignments.length).toBe(1)
    expect(servers.size).toBe(1)
    expect(result.removedAssignments).toBe(0)
    expect(result.removedOrphanedServers).toBe(0)
  })
})

describe('reconcileMCPServers — Phase 2a (stale assignments)', () => {
  it('removes an assignment whose serverId is no longer in agent.json', () => {
    const { adapter, assignments } = makeFakeState({
      servers: [{ id: 'paper', registryId: null }, { id: 'old-server', registryId: null }],
      assignments: [
        { serverId: 'paper', profileId: 'coder' },
        { serverId: 'old-server', profileId: 'coder' },
      ],
    })
    const result = reconcileMCPServers(
      [profile('coder', { 'paper': STDIO })],
      adapter,
    )
    expect(assignments).toEqual([{ serverId: 'paper', profileId: 'coder' }])
    expect(result.removedAssignments).toBe(1)
    expect(result.removalLog[0]).toContain("serverId='old-server'")
  })

  it('does NOT touch assignments belonging to a profile that failed to load', () => {
    const { adapter, assignments } = makeFakeState({
      servers: [{ id: 'paper', registryId: null }],
      assignments: [{ serverId: 'paper', profileId: 'coder' }],
    })
    reconcileMCPServers([{ id: 'coder', mcp: null }], adapter)
    expect(assignments.length).toBe(1) // preserved
  })
})

describe('reconcileMCPServers — Phase 2b (orphaned servers)', () => {
  it('removes an mcp_servers row when no profile references it', () => {
    const { adapter, servers } = makeFakeState({
      servers: [
        { id: 'paper', registryId: null },
        { id: 'orphan', registryId: null },
      ],
      assignments: [{ serverId: 'paper', profileId: 'coder' }],
    })
    const result = reconcileMCPServers(
      [profile('coder', { 'paper': STDIO })],
      adapter,
    )
    expect(servers.has('paper')).toBe(true)
    expect(servers.has('orphan')).toBe(false)
    expect(result.removedOrphanedServers).toBe(1)
  })

  it('preserves orphaned rows with registry_id="custom" (user-registered)', () => {
    const { adapter, servers } = makeFakeState({
      servers: [
        { id: 'my-tool-c4vrjq3w', registryId: 'custom' },
      ],
    })
    const result = reconcileMCPServers([], adapter)
    expect(servers.has('my-tool-c4vrjq3w')).toBe(true)
    expect(result.removedOrphanedServers).toBe(0)
  })

  it('preserves orphaned rows with registry_id="detected" (auto-detected)', () => {
    const { adapter, servers } = makeFakeState({
      servers: [
        { id: 'figma', registryId: 'detected' },
      ],
    })
    const result = reconcileMCPServers([], adapter)
    expect(servers.has('figma')).toBe(true)
    expect(result.removedOrphanedServers).toBe(0)
  })

  it('removes a row that was previously profile-referenced but isn\'t any more', () => {
    const { adapter, servers } = makeFakeState({
      servers: [{ id: 'old-mcp', registryId: null }],
      assignments: [{ serverId: 'old-mcp', profileId: 'coder' }],
    })
    // Coder no longer declares old-mcp.
    const result = reconcileMCPServers([profile('coder', {})], adapter)
    expect(servers.size).toBe(0)
    expect(result.removedAssignments).toBe(1)
    expect(result.removedOrphanedServers).toBe(1)
  })

  it('does NOT delete a row that ANY profile still references', () => {
    const { adapter, servers } = makeFakeState({
      servers: [{ id: 'shared', registryId: null }],
      assignments: [
        { serverId: 'shared', profileId: 'coder' },
        { serverId: 'shared', profileId: 'reviewer' },
      ],
    })
    // Coder dropped it, reviewer still has it.
    const result = reconcileMCPServers(
      [profile('coder', {}), profile('reviewer', { 'shared': STDIO })],
      adapter,
    )
    expect(servers.has('shared')).toBe(true)
    expect(result.removedOrphanedServers).toBe(0)
  })
})

describe('reconcileMCPServers — telemetry', () => {
  it('records every removal in removalLog with a clear reason', () => {
    const { adapter } = makeFakeState({
      servers: [
        { id: 'orphaned', registryId: null },
        { id: 'paper', registryId: null },
      ],
      assignments: [
        { serverId: 'orphaned', profileId: 'coder' },
        { serverId: 'paper', profileId: 'coder' },
      ],
    })
    const result = reconcileMCPServers(
      [profile('coder', { 'paper': STDIO })],
      adapter,
    )
    expect(result.removalLog.length).toBe(2)
    expect(result.removalLog.some(line => line.includes('stale assignment'))).toBe(true)
    expect(result.removalLog.some(line => line.includes('orphaned mcp_server'))).toBe(true)
  })

  it('calls the logger.info callback for every removal', () => {
    const { adapter } = makeFakeState({
      servers: [{ id: 'orphan', registryId: null }],
    })
    const lines: string[] = []
    reconcileMCPServers([], adapter, { info: (m) => lines.push(m) })
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('orphaned mcp_server')
  })
})

describe('reconcileMCPServers — full lifecycle scenarios', () => {
  it('end-to-end: add, remove, replace across two reconcile passes', () => {
    const { adapter, servers, assignments } = makeFakeState()
    // Pass 1 — initial sync from a fresh DB.
    reconcileMCPServers(
      [profile('coder', { 'paper': STDIO, 'pencil': STDIO })],
      adapter,
    )
    expect(servers.size).toBe(2)
    expect(assignments.length).toBe(2)

    // Pass 2 — user removed pencil, added a new MCP.
    const result = reconcileMCPServers(
      [profile('coder', { 'paper': STDIO, 'sequential-thinking': STDIO })],
      adapter,
    )
    expect(servers.size).toBe(2)
    expect(servers.has('paper')).toBe(true)
    expect(servers.has('sequential-thinking')).toBe(true)
    expect(servers.has('pencil')).toBe(false)
    expect(result.removedAssignments).toBe(1)
    expect(result.removedOrphanedServers).toBe(1)
  })

  it('user-registered custom row survives even when never in any profile', () => {
    const { adapter, servers } = makeFakeState({
      servers: [{ id: 'my-test-c4vrjq3w', registryId: 'custom' }],
    })
    // Run reconcile with no profiles at all.
    reconcileMCPServers([], adapter)
    expect(servers.has('my-test-c4vrjq3w')).toBe(true)
  })

  it('mix: profile rows get reconciled, custom + detected stay', () => {
    const { adapter, servers } = makeFakeState({
      servers: [
        { id: 'orphan', registryId: null },           // delete
        { id: 'paper', registryId: null },             // keep (in profile)
        { id: 'figma', registryId: 'detected' },       // keep (detected)
        { id: 'my-tool-c4vrjq3w', registryId: 'custom' }, // keep (custom)
      ],
      assignments: [
        { serverId: 'orphan', profileId: 'coder' },
        { serverId: 'paper', profileId: 'coder' },
      ],
    })
    const result = reconcileMCPServers(
      [profile('coder', { 'paper': STDIO })],
      adapter,
    )
    expect(servers.has('orphan')).toBe(false)
    expect(servers.has('paper')).toBe(true)
    expect(servers.has('figma')).toBe(true)
    expect(servers.has('my-tool-c4vrjq3w')).toBe(true)
    expect(result.removedAssignments).toBe(1)
    expect(result.removedOrphanedServers).toBe(1)
  })

  it('idempotent: running twice with the same input produces the same DB state', () => {
    const { adapter, servers, assignments } = makeFakeState()
    reconcileMCPServers([profile('coder', { 'paper': STDIO })], adapter)
    const after1Servers = [...servers.keys()].sort()
    const after1Assignments = [...assignments].map(a => `${a.profileId}:${a.serverId}`).sort()

    reconcileMCPServers([profile('coder', { 'paper': STDIO })], adapter)
    const after2Servers = [...servers.keys()].sort()
    const after2Assignments = [...assignments].map(a => `${a.profileId}:${a.serverId}`).sort()

    expect(after2Servers).toEqual(after1Servers)
    expect(after2Assignments).toEqual(after1Assignments)
  })
})
