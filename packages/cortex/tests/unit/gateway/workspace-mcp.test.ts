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
    it('creates a workspace with auto-derived name', async () => {
      const ws = await state.createWorkspace('/Users/test/projects/my-app')
      expect(ws.id).toMatch(/^ws_/)
      expect(ws.name).toBe('my-app')
      expect(ws.path).toBe('/Users/test/projects/my-app')
      expect(ws.status).toBe('active')
      expect(ws.pinned).toBe(false)
    })

    it('creates a workspace with custom name', async () => {
      const ws = await state.createWorkspace('/tmp/project', 'My Project')
      expect(ws.name).toBe('My Project')
    })

    it('gets workspace by id', async () => {
      const created = await state.createWorkspace('/tmp/a')
      const fetched = await state.getWorkspace(created.id)
      expect(fetched).toBeDefined()
      expect(fetched!.path).toBe('/tmp/a')
    })

    it('gets workspace by path', async () => {
      await state.createWorkspace('/tmp/b')
      const fetched = await state.getWorkspaceByPath('/tmp/b')
      expect(fetched).toBeDefined()
      expect(fetched!.name).toBe('b')
    })

    it('returns undefined for non-existent workspace', async () => {
      expect(await state.getWorkspace('ws_nonexistent')).toBeUndefined()
      expect(await state.getWorkspaceByPath('/nonexistent')).toBeUndefined()
    })

    it('lists all workspaces', async () => {
      await state.createWorkspace('/tmp/first')
      await state.createWorkspace('/tmp/second')
      await state.createWorkspace('/tmp/third')
      const list = await state.listWorkspaces()
      expect(list.items).toHaveLength(3)
    })

    it('lists only active workspaces', async () => {
      const ws = await state.createWorkspace('/tmp/arch')
      await state.updateWorkspace(ws.id, { status: 'archived' })
      await state.createWorkspace('/tmp/act')
      expect((await state.listWorkspaces('active')).items).toHaveLength(1)
      expect((await state.listWorkspaces('archived')).items).toHaveLength(1)
    })

    it('updates workspace name and pin', async () => {
      const ws = await state.createWorkspace('/tmp/u')
      const updated = await state.updateWorkspace(ws.id, { name: 'Renamed', pinned: true })
      expect(updated!.name).toBe('Renamed')
      expect(updated!.pinned).toBe(true)
    })

    it('pinned workspaces appear first', async () => {
      await state.createWorkspace('/tmp/unpinned')
      const pinned = await state.createWorkspace('/tmp/pinned')
      await state.updateWorkspace(pinned.id, { pinned: true })
      const list = await state.listWorkspaces()
      expect(list.items[0]!.name).toBe('pinned')
    })

    it('deletes workspace', async () => {
      const ws = await state.createWorkspace('/tmp/d')
      expect(await state.deleteWorkspace(ws.id)).toBe(true)
      expect(await state.getWorkspace(ws.id)).toBeUndefined()
    })

    it('delete returns false for non-existent', async () => {
      expect(await state.deleteWorkspace('ws_nope')).toBe(false)
    })

    it('prevents duplicate paths', async () => {
      await state.createWorkspace('/tmp/dup')
      await expect(state.createWorkspace('/tmp/dup')).rejects.toThrow()
    })
  })

  // ── Workspace Detail ───────────────────────────────────────────────

  describe('Workspace Detail', () => {
    it('includes profile entries and thread counts', async () => {
      const ws = await state.createWorkspace('/tmp/detail')
      await state.createThread('coder', 'Thread 1', ws.id)
      await state.createThread('coder', 'Thread 2', ws.id)
      await state.createThread('pentester', 'Thread 3', ws.id)

      const detail = await state.getWorkspaceDetail(ws.id)
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
    it('creates thread with workspaceId', async () => {
      const ws = await state.createWorkspace('/tmp/tw')
      const thread = await state.createThread('coder', 'test', ws.id)
      expect(thread.workspaceId).toBe(ws.id)
    })

    it('creates thread without workspaceId (backwards compat)', async () => {
      const thread = await state.createThread('coder', 'legacy')
      expect(thread.workspaceId).toBeNull()
    })

    it('lists threads by workspace', async () => {
      const ws1 = await state.createWorkspace('/tmp/ws1')
      const ws2 = await state.createWorkspace('/tmp/ws2')
      await state.createThread('coder', 'A', ws1.id)
      await state.createThread('coder', 'B', ws1.id)
      await state.createThread('coder', 'C', ws2.id)

      expect(await state.listThreadsByWorkspace(ws1.id)).toHaveLength(2)
      expect(await state.listThreadsByWorkspace(ws2.id)).toHaveLength(1)
    })

    it('deleting workspace nullifies thread workspace_id', async () => {
      const ws = await state.createWorkspace('/tmp/del')
      const thread = await state.createThread('coder', 'orphan', ws.id)
      await state.deleteWorkspace(ws.id)
      const orphaned = await state.getThread(thread.id)
      expect(orphaned).toBeDefined()
      expect(orphaned!.workspaceId).toBeNull()
    })
  })

  // ── MCP Server CRUD ────────────────────────────────────────────────

  describe('MCP Server CRUD', () => {
    it('creates an MCP server', async () => {
      const server = await state.createMCPServer({
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

    it('creates stdio server with command and args', async () => {
      const server = await state.createMCPServer({
        id: 'local-tool',
        name: 'Local Tool',
        transport: 'stdio',
        command: 'npx',
        args: ['@mcp/server-tool', '--port', '3000'],
      })
      expect(server.command).toBe('npx')
      expect(server.args).toEqual(['@mcp/server-tool', '--port', '3000'])
    })

    it('gets server by id with profile assignments', async () => {
      await state.createMCPServer({ id: 'test-srv', name: 'Test', transport: 'http', url: 'http://localhost' })
      await state.assignServerToProfile('test-srv', 'coder')
      await state.assignServerToProfile('test-srv', 'pentester')

      const server = await state.getMCPServer('test-srv')
      expect(server!.profileIds).toContain('coder')
      expect(server!.profileIds).toContain('pentester')
    })

    it('lists all MCP servers', async () => {
      await state.createMCPServer({ id: 'a', name: 'Alpha', transport: 'sse', url: 'https://a' })
      await state.createMCPServer({ id: 'b', name: 'Beta', transport: 'http', url: 'https://b' })
      expect((await state.listMCPServers()).items).toHaveLength(2)
    })

    it('updates server status and tool count', async () => {
      await state.createMCPServer({ id: 'upd', name: 'Update', transport: 'sse', url: 'https://u' })
      const updated = await state.updateMCPServer('upd', { status: 'connected', toolCount: 12 })
      expect(updated!.status).toBe('connected')
      expect(updated!.toolCount).toBe(12)
    })

    it('deletes server and cascades to profile assignments', async () => {
      await state.createMCPServer({ id: 'del', name: 'Delete', transport: 'sse', url: 'https://d' })
      await state.assignServerToProfile('del', 'coder')
      expect(await state.deleteMCPServer('del')).toBe(true)
      expect(await state.getServersForProfile('coder')).toHaveLength(0)
    })
  })

  // ── Profile-Server Assignment ──────────────────────────────────────

  describe('Profile-Server Assignment', () => {
    it('assigns server to profile', async () => {
      await state.createMCPServer({ id: 'gh', name: 'GitHub', transport: 'sse', url: 'https://gh' })
      await state.assignServerToProfile('gh', 'coder')
      const servers = await state.getServersForProfile('coder')
      expect(servers).toHaveLength(1)
      expect(servers[0]!.id).toBe('gh')
    })

    it('duplicate assignment is idempotent', async () => {
      await state.createMCPServer({ id: 'dup', name: 'Dup', transport: 'sse', url: 'https://dup' })
      await state.assignServerToProfile('dup', 'coder')
      await state.assignServerToProfile('dup', 'coder') // no error
      expect(await state.getServersForProfile('coder')).toHaveLength(1)
    })

    it('removes server from profile', async () => {
      await state.createMCPServer({ id: 'rm', name: 'Rm', transport: 'sse', url: 'https://rm' })
      await state.assignServerToProfile('rm', 'coder')
      expect(await state.removeServerFromProfile('rm', 'coder')).toBe(true)
      expect(await state.getServersForProfile('coder')).toHaveLength(0)
    })

    it('remove returns false when not assigned', async () => {
      await state.createMCPServer({ id: 'no', name: 'No', transport: 'sse', url: 'https://no' })
      expect(await state.removeServerFromProfile('no', 'coder')).toBe(false)
    })

    it('one server can be assigned to multiple profiles', async () => {
      await state.createMCPServer({ id: 'shared', name: 'Shared', transport: 'sse', url: 'https://s' })
      await state.assignServerToProfile('shared', 'coder')
      await state.assignServerToProfile('shared', 'pentester')
      await state.assignServerToProfile('shared', 'researcher')

      const server = await state.getMCPServer('shared')
      expect(server!.profileIds).toHaveLength(3)
    })
  })

  // ── Dashboard Stats ────────────────────────────────────────────────

  describe('Dashboard Stats', () => {
    it('returns stats structure', async () => {
      const stats = await state.getDashboardStats()
      expect(stats).toHaveProperty('activeAgents')
      expect(stats).toHaveProperty('todayRuns')
      expect(stats).toHaveProperty('todayTokens')
      expect(stats).toHaveProperty('todayCost')
      expect(stats).toHaveProperty('weekCost')
      expect(stats).toHaveProperty('workspaceCount')
      expect(stats).toHaveProperty('byProfile')
      expect(stats).toHaveProperty('byWorkspace')
    })

    it('counts workspaces', async () => {
      await state.createWorkspace('/tmp/ds1')
      await state.createWorkspace('/tmp/ds2')
      const stats = await state.getDashboardStats()
      expect(stats.workspaceCount).toBe(2)
    })

    it('reports zero when empty', async () => {
      const stats = await state.getDashboardStats()
      expect(stats.todayRuns).toBe(0)
      expect(stats.todayCost).toBe(0)
      expect(stats.workspaceCount).toBe(0)
    })
  })
})
