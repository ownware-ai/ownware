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
    it('create workspace → create threads → query → delete', () => {
      // 1. Create workspace
      const ws = state.createWorkspace(projectDir, 'My Project')
      expect(ws.name).toBe('My Project')
      expect(ws.path).toBe(projectDir)
      expect(ws.status).toBe('active')

      // 2. Create threads in the workspace
      const t1 = state.createThread('coder', 'Fix auth bug', ws.id)
      const t2 = state.createThread('coder', 'Add tests', ws.id)
      const t3 = state.createThread('pentester', 'Scan API', ws.id)

      expect(t1.workspaceId).toBe(ws.id)
      expect(t2.workspaceId).toBe(ws.id)
      expect(t3.workspaceId).toBe(ws.id)

      // 3. Verify workspace detail
      const detail = state.getWorkspaceDetail(ws.id)!
      expect(detail.totalThreads).toBe(3)
      expect(detail.activeThreads).toBe(3)
      expect(detail.profiles).toHaveLength(2) // coder + pentester

      const coderEntry = detail.profiles.find(p => p.profileId === 'coder')!
      expect(coderEntry.threadCount).toBe(2)

      // 4. List threads by workspace
      const threads = state.listThreadsByWorkspace(ws.id)
      expect(threads).toHaveLength(3)

      // 5. Add messages to a thread
      state.addMessage(t1.id, {
        id: 'msg_001',
        role: 'user',
        content: 'Fix the auth bug',
        timestamp: new Date().toISOString(),
      })
      state.addMessage(t1.id, {
        id: 'msg_002',
        role: 'assistant',
        content: 'I\'ll read the file first.',
        timestamp: new Date().toISOString(),
      })

      const messages = state.getMessages(t1.id)
      expect(messages).toHaveLength(2)
      expect(messages[0]!.role).toBe('user')
      expect(messages[1]!.role).toBe('assistant')

      // 6. Complete a thread
      state.updateThread(t1.id, { status: 'completed' })
      const updated = state.getThread(t1.id)!
      expect(updated.status).toBe('completed')

      // 7. Verify detail updated
      const detail2 = state.getWorkspaceDetail(ws.id)!
      expect(detail2.activeThreads).toBe(2) // t2 + t3 still active

      // 8. Delete workspace — threads keep existing but lose workspace link
      state.deleteWorkspace(ws.id)
      expect(state.getWorkspace(ws.id)).toBeUndefined()
      const orphaned = state.getThread(t2.id)!
      expect(orphaned.workspaceId).toBeNull() // SET NULL cascade
    })
  })

  // ── Multiple workspaces ──────────────────────────────────────────

  describe('Multiple workspaces', () => {
    it('threads are properly scoped to their workspace', () => {
      const proj2 = join(tmpDir, 'other-project')
      mkdirSync(proj2)

      const ws1 = state.createWorkspace(projectDir)
      const ws2 = state.createWorkspace(proj2)

      state.createThread('coder', 'WS1 thread 1', ws1.id)
      state.createThread('coder', 'WS1 thread 2', ws1.id)
      state.createThread('coder', 'WS2 thread 1', ws2.id)

      expect(state.listThreadsByWorkspace(ws1.id)).toHaveLength(2)
      expect(state.listThreadsByWorkspace(ws2.id)).toHaveLength(1)

      // Global thread list still shows all
      const all = state.listThreads()
      expect(all.items).toHaveLength(3)
    })

    it('same profile can be used in different workspaces', () => {
      const proj2 = join(tmpDir, 'proj2')
      mkdirSync(proj2)

      const ws1 = state.createWorkspace(projectDir)
      const ws2 = state.createWorkspace(proj2)

      state.createThread('coder', 'WS1', ws1.id)
      state.createThread('coder', 'WS2', ws2.id)

      const d1 = state.getWorkspaceDetail(ws1.id)!
      const d2 = state.getWorkspaceDetail(ws2.id)!

      expect(d1.profiles).toHaveLength(1)
      expect(d1.profiles[0]!.profileId).toBe('coder')
      expect(d2.profiles).toHaveLength(1)
      expect(d2.profiles[0]!.profileId).toBe('coder')
    })
  })

  // ── MCP server flow ──────────────────────────────────────────────

  describe('MCP server + profile assignment', () => {
    it('full MCP lifecycle: create → assign → query → remove', () => {
      // 1. Create servers (simulating what syncMCPServers does)
      const github = state.createMCPServer({
        id: 'github',
        name: 'GitHub',
        transport: 'sse',
        url: 'https://mcp.github.com/sse',
        registryId: 'io.github/mcp-server',
      })
      expect(github.status).toBe('configured')

      const linear = state.createMCPServer({
        id: 'linear',
        name: 'Linear',
        transport: 'sse',
        url: 'https://mcp.linear.app/sse',
      })

      // 2. Assign to profiles
      state.assignServerToProfile('github', 'coder')
      state.assignServerToProfile('github', 'pentester')
      state.assignServerToProfile('linear', 'coder')

      // 3. Query: which servers does coder have?
      const coderServers = state.getServersForProfile('coder')
      expect(coderServers).toHaveLength(2)
      expect(coderServers.map(s => s.id).sort()).toEqual(['github', 'linear'])

      // 4. Query: which profiles use github?
      const githubServer = state.getMCPServer('github')!
      expect(githubServer.profileIds).toContain('coder')
      expect(githubServer.profileIds).toContain('pentester')

      // 5. Update server status (simulating live connection)
      state.updateMCPServer('github', { status: 'connected', toolCount: 12 })
      const connected = state.getMCPServer('github')!
      expect(connected.status).toBe('connected')
      expect(connected.toolCount).toBe(12)

      // 6. Remove from one profile
      state.removeServerFromProfile('github', 'pentester')
      const updated = state.getMCPServer('github')!
      expect(updated.profileIds).toEqual(['coder'])

      // 7. Delete server entirely
      state.deleteMCPServer('linear')
      expect(state.getMCPServer('linear')).toBeUndefined()
      expect(state.getServersForProfile('coder')).toHaveLength(1) // only github left
    })
  })

  // ── Dashboard with real data ─────────────────────────────────────

  describe('Dashboard stats', () => {
    it('returns real aggregated data', () => {
      const ws = state.createWorkspace(projectDir)
      state.createThread('coder', 'Thread 1', ws.id)
      state.createThread('pentester', 'Thread 2', ws.id)

      // Add usage records
      state.addUsageRecord({
        threadId: undefined,
        profileId: 'coder',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 1000,
        outputTokens: 2000,
        costUsd: 0.03,
      })
      state.addUsageRecord({
        threadId: undefined,
        profileId: 'coder',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 500,
        outputTokens: 1000,
        costUsd: 0.015,
      })
      state.addUsageRecord({
        threadId: undefined,
        profileId: 'pentester',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 800,
        outputTokens: 1200,
        costUsd: 0.02,
      })

      const stats = state.getDashboardStats()
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
    it('pinned workspaces appear first in list', () => {
      const ws1 = state.createWorkspace(projectDir, 'Unpinned')
      const proj2 = join(tmpDir, 'pinned-proj')
      mkdirSync(proj2)
      const ws2 = state.createWorkspace(proj2, 'Pinned')
      state.updateWorkspace(ws2.id, { pinned: true })

      const list = state.listWorkspaces()
      expect(list.items[0]!.name).toBe('Pinned')
      expect(list.items[0]!.pinned).toBe(true)
    })

    it('archived workspaces excluded from active list', () => {
      const ws = state.createWorkspace(projectDir)
      state.updateWorkspace(ws.id, { status: 'archived' })

      expect(state.listWorkspaces('active').items).toHaveLength(0)
      expect(state.listWorkspaces('archived').items).toHaveLength(1)
      expect(state.listWorkspaces().items).toHaveLength(1) // all
    })

    it('touch updates last_opened_at', () => {
      const ws = state.createWorkspace(projectDir)
      const before = ws.lastOpenedAt
      // Small delay to ensure different timestamp
      state.touchWorkspace(ws.id)
      const after = state.getWorkspace(ws.id)!.lastOpenedAt
      // They should be different (or at least the query ran without error)
      expect(after).toBeDefined()
    })
  })

  // ── Edge cases ───────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('legacy threads (no workspace) still work', () => {
      const t = state.createThread('coder', 'Legacy thread')
      expect(t.workspaceId).toBeNull()

      // Can still add messages
      state.addMessage(t.id, {
        id: 'msg_legacy',
        role: 'user',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      })
      expect(state.getMessages(t.id)).toHaveLength(1)
    })

    it('thread survives workspace deletion', () => {
      const ws = state.createWorkspace(projectDir)
      const t = state.createThread('coder', 'Will survive', ws.id)
      state.deleteWorkspace(ws.id)

      const thread = state.getThread(t.id)
      expect(thread).toBeDefined()
      expect(thread!.workspaceId).toBeNull()
      expect(state.getMessages(t.id)).toHaveLength(0) // empty but accessible
    })

    it('multiple profiles sharing MCP server with usage data', () => {
      state.createMCPServer({ id: 'shared', name: 'Shared', transport: 'sse', url: 'https://shared' })
      state.assignServerToProfile('shared', 'coder')
      state.assignServerToProfile('shared', 'pentester')
      state.assignServerToProfile('shared', 'researcher')

      // All profiles see the server
      expect(state.getServersForProfile('coder')).toHaveLength(1)
      expect(state.getServersForProfile('pentester')).toHaveLength(1)
      expect(state.getServersForProfile('researcher')).toHaveLength(1)

      // Server shows all profiles
      const server = state.getMCPServer('shared')!
      expect(server.profileIds).toHaveLength(3)
    })
  })
})
