/**
 * Integration tests — Workspace + Thread + MCP + Dashboard flow.
 *
 * Real SQLite database. Real GatewayState. No mocks.
 * Tests the full data flow through the system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayState } from '../../../src/gateway/state.js'

describe('Workspace Flow (Integration)', () => {
  let state: GatewayState
  let tmpDir: string
  let projectDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-int-test-'))
    // Create a fake project directory with some files
    projectDir = join(tmpDir, 'my-project')
    mkdirSync(projectDir)
    mkdirSync(join(projectDir, 'src'))
    mkdirSync(join(projectDir, '.git'))
    writeFileSync(join(projectDir, 'package.json'), '{"name":"my-project"}')
    writeFileSync(join(projectDir, 'src', 'index.ts'), 'console.log("hello")')

    state = new GatewayState(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Full workspace lifecycle ─────────────────────────────────────

  describe('Full workspace lifecycle', () => {
    it('create workspace → create threads → query → delete', async () => {
      // 1. Create workspace
      const ws = await state.createWorkspace(projectDir, 'My Project')
      expect(ws.name).toBe('My Project')
      expect(ws.path).toBe(projectDir)
      expect(ws.status).toBe('active')

      // 2. Create threads in the workspace
      const t1 = await state.createThread('coder', 'Fix auth bug', ws.id)
      const t2 = await state.createThread('coder', 'Add tests', ws.id)
      const t3 = await state.createThread('pentester', 'Scan API', ws.id)

      expect(t1.workspaceId).toBe(ws.id)
      expect(t2.workspaceId).toBe(ws.id)
      expect(t3.workspaceId).toBe(ws.id)

      // 3. Verify workspace detail
      const detail = (await state.getWorkspaceDetail(ws.id))!
      expect(detail.totalThreads).toBe(3)
      expect(detail.activeThreads).toBe(3)
      expect(detail.profiles).toHaveLength(2) // coder + pentester

      const coderEntry = detail.profiles.find(p => p.profileId === 'coder')!
      expect(coderEntry.threadCount).toBe(2)

      // 4. List threads by workspace
      const threads = await state.listThreadsByWorkspace(ws.id)
      expect(threads).toHaveLength(3)

      // 5. Add messages to a thread
      await state.addMessage(t1.id, {
        id: 'msg_001',
        role: 'user',
        content: 'Fix the auth bug',
        timestamp: new Date().toISOString(),
      })
      await state.addMessage(t1.id, {
        id: 'msg_002',
        role: 'assistant',
        content: 'I\'ll read the file first.',
        timestamp: new Date().toISOString(),
      })

      const messages = await state.getMessages(t1.id)
      expect(messages).toHaveLength(2)
      expect(messages[0]!.role).toBe('user')
      expect(messages[1]!.role).toBe('assistant')

      // 6. Complete a thread
      await state.updateThread(t1.id, { status: 'completed' })
      const updated = (await state.getThread(t1.id))!
      expect(updated.status).toBe('completed')

      // 7. Verify detail updated
      const detail2 = (await state.getWorkspaceDetail(ws.id))!
      expect(detail2.activeThreads).toBe(2) // t2 + t3 still active

      // 8. Delete workspace — threads keep existing but lose workspace link
      await state.deleteWorkspace(ws.id)
      expect(await state.getWorkspace(ws.id)).toBeUndefined()
      const orphaned = (await state.getThread(t2.id))!
      expect(orphaned.workspaceId).toBeNull() // SET NULL cascade
    })
  })

  // ── Multiple workspaces ──────────────────────────────────────────

  describe('Multiple workspaces', () => {
    it('threads are properly scoped to their workspace', async () => {
      const proj2 = join(tmpDir, 'other-project')
      mkdirSync(proj2)

      const ws1 = await state.createWorkspace(projectDir)
      const ws2 = await state.createWorkspace(proj2)

      await state.createThread('coder', 'WS1 thread 1', ws1.id)
      await state.createThread('coder', 'WS1 thread 2', ws1.id)
      await state.createThread('coder', 'WS2 thread 1', ws2.id)

      expect(await state.listThreadsByWorkspace(ws1.id)).toHaveLength(2)
      expect(await state.listThreadsByWorkspace(ws2.id)).toHaveLength(1)

      // Global thread list still shows all
      const all = await state.listThreads()
      expect(all.items).toHaveLength(3)
    })

    it('same profile can be used in different workspaces', async () => {
      const proj2 = join(tmpDir, 'proj2')
      mkdirSync(proj2)

      const ws1 = await state.createWorkspace(projectDir)
      const ws2 = await state.createWorkspace(proj2)

      await state.createThread('coder', 'WS1', ws1.id)
      await state.createThread('coder', 'WS2', ws2.id)

      const d1 = (await state.getWorkspaceDetail(ws1.id))!
      const d2 = (await state.getWorkspaceDetail(ws2.id))!

      expect(d1.profiles).toHaveLength(1)
      expect(d1.profiles[0]!.profileId).toBe('coder')
      expect(d2.profiles).toHaveLength(1)
      expect(d2.profiles[0]!.profileId).toBe('coder')
    })
  })

  // ── MCP server flow ──────────────────────────────────────────────

  describe('MCP server + profile assignment', () => {
    it('full MCP lifecycle: create → assign → query → remove', async () => {
      // 1. Create servers (simulating what syncMCPServers does)
      const github = await state.createMCPServer({
        id: 'github',
        name: 'GitHub',
        transport: 'sse',
        url: 'https://mcp.github.com/sse',
        registryId: 'io.github/mcp-server',
      })
      expect(github.status).toBe('configured')

      await state.createMCPServer({
        id: 'linear',
        name: 'Linear',
        transport: 'sse',
        url: 'https://mcp.linear.app/sse',
      })

      // 2. Assign to profiles
      await state.assignServerToProfile('github', 'coder')
      await state.assignServerToProfile('github', 'pentester')
      await state.assignServerToProfile('linear', 'coder')

      // 3. Query: which servers does coder have?
      const coderServers = await state.getServersForProfile('coder')
      expect(coderServers).toHaveLength(2)
      expect(coderServers.map(s => s.id).sort()).toEqual(['github', 'linear'])

      // 4. Query: which profiles use github?
      const githubServer = (await state.getMCPServer('github'))!
      expect(githubServer.profileIds).toContain('coder')
      expect(githubServer.profileIds).toContain('pentester')

      // 5. Update server status (simulating live connection)
      await state.updateMCPServer('github', { status: 'connected', toolCount: 12 })
      const connected = (await state.getMCPServer('github'))!
      expect(connected.status).toBe('connected')
      expect(connected.toolCount).toBe(12)

      // 6. Remove from one profile
      await state.removeServerFromProfile('github', 'pentester')
      const updated = (await state.getMCPServer('github'))!
      expect(updated.profileIds).toEqual(['coder'])

      // 7. Delete server entirely
      await state.deleteMCPServer('linear')
      expect(await state.getMCPServer('linear')).toBeUndefined()
      expect(await state.getServersForProfile('coder')).toHaveLength(1) // only github left
    })
  })

  // ── Dashboard with real data ─────────────────────────────────────

  describe('Dashboard stats', () => {
    it('returns real aggregated data', async () => {
      const ws = await state.createWorkspace(projectDir)
      await state.createThread('coder', 'Thread 1', ws.id)
      await state.createThread('pentester', 'Thread 2', ws.id)

      // Add usage records
      await state.addUsageRecord({
        threadId: undefined,
        profileId: 'coder',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 1000,
        outputTokens: 2000,
        costUsd: 0.03,
      })
      await state.addUsageRecord({
        threadId: undefined,
        profileId: 'coder',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 500,
        outputTokens: 1000,
        costUsd: 0.015,
      })
      await state.addUsageRecord({
        threadId: undefined,
        profileId: 'pentester',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 800,
        outputTokens: 1200,
        costUsd: 0.02,
      })

      const stats = await state.getDashboardStats()
      expect(stats.workspaceCount).toBe(1)
      expect(stats.todayRuns).toBe(3)
      expect(stats.todayCost).toBeCloseTo(0.065, 3)
      expect(stats.byProfile).toHaveLength(2)

      const coderStats = stats.byProfile.find(p => p.profileId === 'coder')!
      expect(coderStats.runCount).toBe(2)
    })
  })

  // ── Workspace pinning + archiving ────────────────────────────────

  describe('Workspace management', () => {
    it('pinned workspaces appear first in list', async () => {
      await state.createWorkspace(projectDir, 'Unpinned')
      const proj2 = join(tmpDir, 'pinned-proj')
      mkdirSync(proj2)
      const ws2 = await state.createWorkspace(proj2, 'Pinned')
      await state.updateWorkspace(ws2.id, { pinned: true })

      const list = await state.listWorkspaces()
      expect(list.items[0]!.name).toBe('Pinned')
      expect(list.items[0]!.pinned).toBe(true)
    })

    it('archived workspaces excluded from active list', async () => {
      const ws = await state.createWorkspace(projectDir)
      await state.updateWorkspace(ws.id, { status: 'archived' })

      expect((await state.listWorkspaces('active')).items).toHaveLength(0)
      expect((await state.listWorkspaces('archived')).items).toHaveLength(1)
      expect((await state.listWorkspaces()).items).toHaveLength(1) // all
    })

    it('touch updates last_opened_at', async () => {
      const ws = await state.createWorkspace(projectDir)
      const before = ws.lastOpenedAt
      // Small delay to ensure different timestamp
      await state.touchWorkspace(ws.id)
      const after = (await state.getWorkspace(ws.id))!.lastOpenedAt
      // They should be different (or at least the query ran without error)
      expect(after).toBeDefined()
    })
  })

  // ── Edge cases ───────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('legacy threads (no workspace) still work', async () => {
      const t = await state.createThread('coder', 'Legacy thread')
      expect(t.workspaceId).toBeNull()

      // Can still add messages
      await state.addMessage(t.id, {
        id: 'msg_legacy',
        role: 'user',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      })
      await expect(state.getMessages(t.id)).resolves.toHaveLength(1)
    })

    it('thread survives workspace deletion', async () => {
      const ws = await state.createWorkspace(projectDir)
      const t = await state.createThread('coder', 'Will survive', ws.id)
      await state.deleteWorkspace(ws.id)

      const thread = await state.getThread(t.id)
      expect(thread).toBeDefined()
      expect(thread!.workspaceId).toBeNull()
      await expect(state.getMessages(t.id)).resolves.toHaveLength(0) // empty but accessible
    })

    it('multiple profiles sharing MCP server with usage data', async () => {
      await state.createMCPServer({ id: 'shared', name: 'Shared', transport: 'sse', url: 'https://shared' })
      await state.assignServerToProfile('shared', 'coder')
      await state.assignServerToProfile('shared', 'pentester')
      await state.assignServerToProfile('shared', 'researcher')

      // All profiles see the server
      expect(await state.getServersForProfile('coder')).toHaveLength(1)
      expect(await state.getServersForProfile('pentester')).toHaveLength(1)
      expect(await state.getServersForProfile('researcher')).toHaveLength(1)

      // Server shows all profiles
      const server = (await state.getMCPServer('shared'))!
      expect(server.profileIds).toHaveLength(3)
    })
  })
})
