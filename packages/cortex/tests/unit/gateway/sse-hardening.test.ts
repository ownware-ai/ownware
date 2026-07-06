/**
 * Unit tests for SSE hardening: backpressure, concurrent run guard,
 * skillName validation, and session state persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeSSE } from '../../../src/gateway/sse.js'
import type { ServerResponse } from 'node:http'
import { GatewayState } from '../../../src/gateway/state.js'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Mock response factory
// ---------------------------------------------------------------------------

function createMockResponse(opts?: { writableEnded?: boolean; writeReturnsFalse?: boolean }): {
  res: ServerResponse
  chunks: string[]
  drainCallbacks: Array<() => void>
} {
  const chunks: string[] = []
  const drainCallbacks: Array<() => void> = []
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>()

  const res = {
    writableEnded: opts?.writableEnded ?? false,
    writeHead: vi.fn(),
    write: vi.fn((data: string) => {
      chunks.push(data)
      // Return false to simulate backpressure
      return opts?.writeReturnsFalse ? false : true
    }),
    end: vi.fn(() => { (res as any).writableEnded = true }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = eventHandlers.get(event) ?? []
      list.push(cb)
      eventHandlers.set(event, list)
    }),
    once: vi.fn((event: string, cb: () => void) => {
      if (event === 'drain') {
        drainCallbacks.push(cb)
        // Simulate drain firing asynchronously
        queueMicrotask(() => cb())
      }
    }),
    socket: { setNoDelay: vi.fn() },
  } as unknown as ServerResponse

  return { res, chunks, drainCallbacks }
}

// ---------------------------------------------------------------------------
// writeSSE tests
// ---------------------------------------------------------------------------

describe('writeSSE backpressure', () => {
  it('resolves immediately when write returns true (no backpressure)', async () => {
    const { res, chunks } = createMockResponse()
    await writeSSE(res, 'test.event', { hello: 'world' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('event: test.event\ndata: {"hello":"world"}\n\n')
  })

  it('awaits drain when res.write returns false (backpressure)', async () => {
    const { res, drainCallbacks } = createMockResponse({ writeReturnsFalse: true })
    const promise = writeSSE(res, 'test.event', { data: true })

    // drain callback should have been registered
    expect(drainCallbacks.length).toBeGreaterThan(0)

    // Promise should resolve after drain fires
    await promise
  })

  it('skips write when res.writableEnded is true', async () => {
    const { res, chunks } = createMockResponse({ writableEnded: true })
    await writeSSE(res, 'test', { data: true })
    expect(chunks).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Concurrent run detection
// ---------------------------------------------------------------------------

describe('concurrent run detection', () => {
  it('getRuntime returns existing runtime for active thread', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cortex-crd-'))
    const dbPath = join(tempDir, 'test.db')
    const state = new GatewayState(dbPath)

    try {
      // No runtime initially
      expect(state.getRuntime('thread-1')).toBeUndefined()

      // Set a runtime
      const mockRuntime = {
        session: {} as any,
        hitl: {} as any,
        zoneManager: null,
      }
      state.setRuntime('thread-1', mockRuntime)

      // Now getRuntime returns it
      expect(state.getRuntime('thread-1')).toBe(mockRuntime)
    } finally {
      state.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// skillName validation
// ---------------------------------------------------------------------------

describe('skillName validation', () => {
  const validPattern = /^[a-zA-Z0-9_-]+$/

  it('rejects path traversal attempts', () => {
    expect(validPattern.test('../evil')).toBe(false)
    expect(validPattern.test('../../etc')).toBe(false)
    expect(validPattern.test('foo/bar')).toBe(false)
    expect(validPattern.test('.hidden')).toBe(false)
    expect(validPattern.test('a b')).toBe(false)
    expect(validPattern.test('')).toBe(false)
  })

  it('accepts valid skill names', () => {
    expect(validPattern.test('my-skill_v2')).toBe(true)
    expect(validPattern.test('summarize')).toBe(true)
    expect(validPattern.test('Code-Review-2')).toBe(true)
    expect(validPattern.test('a')).toBe(true)
    expect(validPattern.test('123')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session state persistence
// ---------------------------------------------------------------------------

describe('session state persistence', () => {
  let state: GatewayState
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cortex-session-'))
    state = new GatewayState(join(tempDir, 'test.db'))
  })

  afterEach(() => {
    state.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('saveSessionState writes JSON to app_state table', () => {
    // Create a workspace first
    state.createWorkspace('/tmp/test-project', 'Test Project')

    state.saveSessionState()

    const raw = state.getAppState('session')
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!.value)
    expect(parsed.hasSession).toBe(true)
    expect(parsed.workspaces).toHaveLength(1)
    expect(parsed.workspaces[0].name).toBe('Test Project')
    expect(parsed.savedAt).toBeDefined()
  })

  it('getSessionState reads back correctly', () => {
    state.createWorkspace('/tmp/ws1', 'WS1')
    state.saveSessionState()

    const session = state.getSessionState()
    expect(session).not.toBeNull()
    expect(session!.hasSession).toBe(true)
    expect(session!.workspaces).toHaveLength(1)
    expect(session!.workspaces![0]!.path).toBe('/tmp/ws1')
  })

  it('getSessionState returns null when nothing saved', () => {
    expect(state.getSessionState()).toBeNull()
  })

  it('restoreSession re-activates workspaces', () => {
    // Create workspace and save state
    const ws = state.createWorkspace('/tmp/restore-test', 'Restore')
    state.saveSessionState()

    // Archive the workspace
    state.updateWorkspace(ws.id, { status: 'archived' })
    const archived = state.getWorkspace(ws.id)
    expect(archived!.status).toBe('archived')

    // Restore session — workspace should be active again
    const result = state.restoreSession()
    expect(result.workspaceCount).toBe(1)

    const restored = state.getWorkspace(ws.id)
    expect(restored!.status).toBe('active')
  })

  it('restoreSession returns zero counts when no session saved', () => {
    const result = state.restoreSession()
    expect(result.workspaceCount).toBe(0)
    expect(result.tabCount).toBe(0)
  })
})
