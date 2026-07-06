/**
 * Tests for workspace and MCP server database layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayState } from '../../../src/gateway/state.js'

describe('Workspace + MCP Database', () => {
  let state: GatewayState
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ws-test-'))
    dbPath = join(tmpDir, 'test.db')
    state = new GatewayState(dbPath)
  })

  afterEach(() => {
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Workspace CRUD ─────────────────────────────────────────────────

  describe('Workspace CRUD', () => {
    it('creates a workspace with auto-derived name', () => {
      const ws = state.createWorkspace('/Users/test/projects/my-app')
      expect(ws.id).toMatch(/^ws_/)
      expect(ws.name).toBe('my-app')
      expect(ws.path).toBe('/Users/test/projects/my-app')
      expect(ws.status).toBe('active')
      expect(ws.pinned).toBe(false)
    })

    it('creates a workspace with custom name', () => {
      const ws = state.createWorkspace('/tmp/project', 'My Project')
      expect(ws.name).toBe('My Project')
    })

    it('gets workspace by id', () => {
      const created = state.createWorkspace('/tmp/a')
      const fetched = state.getWorkspace(created.id)
      expect(fetched).toBeDefined()
      expect(fetched!.path).toBe('/tmp/a')
    })

    it('gets workspace by path', () => {
      state.createWorkspace('/tmp/b')
      const fetched = state.getWorkspaceByPath('/tmp/b')
      expect(fetched).toBeDefined()
      expect(fetched!.name).toBe('b')
    })

    it('returns undefined for non-existent workspace', () => {
      expect(state.getWorkspace('ws_nonexistent')).toBeUndefined()
      expect(state.getWorkspaceByPath('/nonexistent')).toBeUndefined()
    })

    it('lists all workspaces', () => {
      state.createWorkspace('/tmp/first')
      state.createWorkspace('/tmp/second')
      state.createWorkspace('/tmp/third')
      const list = state.listWorkspaces()
      expect(list.items).toHaveLength(3)
    })

    it('lists only active workspaces', () => {
      const ws = state.createWorkspace('/tmp/arch')
      state.updateWorkspace(ws.id, { status: 'archived' })
      state.createWorkspace('/tmp/act')
      expect(state.listWorkspaces('active').items).toHaveLength(1)
      expect(state.listWorkspaces('archived').items).toHaveLength(1)
    })

    it('updates workspace name and pin', () => {
      const ws = state.createWorkspace('/tmp/u')
      const updated = state.updateWorkspace(ws.id, { name: 'Renamed', pinned: true })
      expect(updated!.name).toBe('Renamed')
      expect(updated!.pinned).toBe(true)
    })

    it('pinned workspaces appear first', () => {
      state.createWorkspace('/tmp/unpinned')
      const pinned = state.createWorkspace('/tmp/pinned')
      state.updateWorkspace(pinned.id, { pinned: true })
      const list = state.listWorkspaces()
      expect(list.items[0]!.name).toBe('pinned')
    })

    it('deletes workspace', () => {
      const ws = state.createWorkspace('/tmp/d')
      expect(state.deleteWorkspace(ws.id)).toBe(true)
      expect(state.getWorkspace(ws.id)).toBeUndefined()
    })

    it('delete returns false for non-existent', () => {
      expect(state.deleteWorkspace('ws_nope')).toBe(false)
    })

    it('prevents duplicate paths', () => {
      state.createWorkspace('/tmp/dup')
      expect(() => state.createWorkspace('/tmp/dup')).toThrow()
    })
  })

  // ── Workspace Detail ───────────────────────────────────────────────

  describe('Workspace Detail', () => {
    it('includes profile entries and thread counts', () => {
      const ws = state.createWorkspace('/tmp/detail')
      state.createThread('coder', 'Thread 1', ws.id)
      state.createThread('coder', 'Thread 2', ws.id)
      state.createThread('pentester', 'Thread 3', ws.id)

      const detail = state.getWorkspaceDetail(ws.id)
      expect(detail).toBeDefined()
      expect(detail!.totalThreads).toBe(3)
      expect(detail!.activeThreads).toBe(3)
      expect(detail!.profiles).toHaveLength(2)

      const coderProfile = detail!.profiles.find(p => p.profileId === 'coder')
      expect(coderProfile!.threadCount).toBe(2)

      const pentesterProfile = detail!.profiles.find(p => p.profileId === 'pentester')
      expect(pentesterProfile!.threadCount).toBe(1)
    })
  })

  // ── Thread + Workspace ─────────────────────────────────────────────

  describe('Thread + Workspace', () => {
    it('creates thread with workspaceId', () => {
      const ws = state.createWorkspace('/tmp/tw')
      const thread = state.createThread('coder', 'test', ws.id)
      expect(thread.workspaceId).toBe(ws.id)
    })

    it('creates thread without workspaceId (backwards compat)', () => {
      const thread = state.createThread('coder', 'legacy')
      expect(thread.workspaceId).toBeNull()
    })

    it('lists threads by workspace', () => {
      const ws1 = state.createWorkspace('/tmp/ws1')
      const ws2 = state.createWorkspace('/tmp/ws2')
      state.createThread('coder', 'A', ws1.id)
      state.createThread('coder', 'B', ws1.id)
      state.createThread('coder', 'C', ws2.id)

      expect(state.listThreadsByWorkspace(ws1.id)).toHaveLength(2)
      expect(state.listThreadsByWorkspace(ws2.id)).toHaveLength(1)
    })

    it('deleting workspace nullifies thread workspace_id', () => {
      const ws = state.createWorkspace('/tmp/del')
      const thread = state.createThread('coder', 'orphan', ws.id)
      state.deleteWorkspace(ws.id)
      const orphaned = state.getThread(thread.id)
      expect(orphaned).toBeDefined()
      expect(orphaned!.workspaceId).toBeNull()
    })
  })

  // ── MCP Server CRUD ────────────────────────────────────────────────

  describe('MCP Server CRUD', () => {
    it('creates an MCP server', () => {
      const server = state.createMCPServer({
        id: 'github',
        name: 'GitHub',
        transport: 'sse',
        url: 'https://mcp.github.com/sse',
      })
      expect(server.id).toBe('github')
      expect(server.name).toBe('GitHub')
      expect(server.transport).toBe('sse')
      expect(server.url).toBe('https://mcp.github.com/sse')
      expect(server.status).toBe('configured')
      expect(server.profileIds).toEqual([])
    })

    it('creates stdio server with command and args', () => {
      const server = state.createMCPServer({
        id: 'local-tool',
        name: 'Local Tool',
        transport: 'stdio',
        command: 'npx',
        args: ['@mcp/server-tool', '--port', '3000'],
      })
      expect(server.command).toBe('npx')
      expect(server.args).toEqual(['@mcp/server-tool', '--port', '3000'])
    })

    it('gets server by id with profile assignments', () => {
      state.createMCPServer({ id: 'test-srv', name: 'Test', transport: 'http', url: 'http://localhost' })
      state.assignServerToProfile('test-srv', 'coder')
      state.assignServerToProfile('test-srv', 'pentester')

      const server = state.getMCPServer('test-srv')
      expect(server!.profileIds).toContain('coder')
      expect(server!.profileIds).toContain('pentester')
    })

    it('lists all MCP servers', () => {
      state.createMCPServer({ id: 'a', name: 'Alpha', transport: 'sse', url: 'https://a' })
      state.createMCPServer({ id: 'b', name: 'Beta', transport: 'http', url: 'https://b' })
      expect(state.listMCPServers().items).toHaveLength(2)
    })

    it('updates server status and tool count', () => {
      state.createMCPServer({ id: 'upd', name: 'Update', transport: 'sse', url: 'https://u' })
      const updated = state.updateMCPServer('upd', { status: 'connected', toolCount: 12 })
      expect(updated!.status).toBe('connected')
      expect(updated!.toolCount).toBe(12)
    })

    it('deletes server and cascades to profile assignments', () => {
      state.createMCPServer({ id: 'del', name: 'Delete', transport: 'sse', url: 'https://d' })
      state.assignServerToProfile('del', 'coder')
      expect(state.deleteMCPServer('del')).toBe(true)
      expect(state.getServersForProfile('coder')).toHaveLength(0)
    })
  })

  // ── Profile-Server Assignment ──────────────────────────────────────

  describe('Profile-Server Assignment', () => {
    it('assigns server to profile', () => {
      state.createMCPServer({ id: 'gh', name: 'GitHub', transport: 'sse', url: 'https://gh' })
      state.assignServerToProfile('gh', 'coder')
      const servers = state.getServersForProfile('coder')
      expect(servers).toHaveLength(1)
      expect(servers[0]!.id).toBe('gh')
    })

    it('duplicate assignment is idempotent', () => {
      state.createMCPServer({ id: 'dup', name: 'Dup', transport: 'sse', url: 'https://dup' })
      state.assignServerToProfile('dup', 'coder')
      state.assignServerToProfile('dup', 'coder') // no error
      expect(state.getServersForProfile('coder')).toHaveLength(1)
    })

    it('removes server from profile', () => {
      state.createMCPServer({ id: 'rm', name: 'Rm', transport: 'sse', url: 'https://rm' })
      state.assignServerToProfile('rm', 'coder')
      expect(state.removeServerFromProfile('rm', 'coder')).toBe(true)
      expect(state.getServersForProfile('coder')).toHaveLength(0)
    })

    it('remove returns false when not assigned', () => {
      state.createMCPServer({ id: 'no', name: 'No', transport: 'sse', url: 'https://no' })
      expect(state.removeServerFromProfile('no', 'coder')).toBe(false)
    })

    it('one server can be assigned to multiple profiles', () => {
      state.createMCPServer({ id: 'shared', name: 'Shared', transport: 'sse', url: 'https://s' })
      state.assignServerToProfile('shared', 'coder')
      state.assignServerToProfile('shared', 'pentester')
      state.assignServerToProfile('shared', 'researcher')

      const server = state.getMCPServer('shared')
      expect(server!.profileIds).toHaveLength(3)
    })
  })

  // ── Dashboard Stats ────────────────────────────────────────────────

  describe('Dashboard Stats', () => {
    it('returns stats structure', () => {
      const stats = state.getDashboardStats()
      expect(stats).toHaveProperty('activeAgents')
      expect(stats).toHaveProperty('todayRuns')
      expect(stats).toHaveProperty('todayTokens')
      expect(stats).toHaveProperty('todayCost')
      expect(stats).toHaveProperty('weekCost')
      expect(stats).toHaveProperty('workspaceCount')
      expect(stats).toHaveProperty('byProfile')
      expect(stats).toHaveProperty('byWorkspace')
    })

    it('counts workspaces', () => {
      state.createWorkspace('/tmp/ds1')
      state.createWorkspace('/tmp/ds2')
      const stats = state.getDashboardStats()
      expect(stats.workspaceCount).toBe(2)
    })

    it('reports zero when empty', () => {
      const stats = state.getDashboardStats()
      expect(stats.todayRuns).toBe(0)
      expect(stats.todayCost).toBe(0)
      expect(stats.workspaceCount).toBe(0)
    })
  })
})
