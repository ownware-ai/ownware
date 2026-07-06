/**
 * Regression test for SP01 (terminal-followups-2026-04-23 board).
 *
 * Deleting a workspace must kill every live PTY bound to it. Without
 * this wire, a long-running gateway accumulates orphan shell
 * processes per workspace-delete until the next `shutdown()`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWorkspaceHandlers } from '../../../src/gateway/handlers/workspaces.js'
import type { GatewayState } from '../../../src/gateway/state.js'
import type { TerminalSessionRegistry } from '../../../src/terminal/session-registry.js'

interface Captured {
  status: number
  body: unknown
}

function mockReq(): IncomingMessage {
  const req = {
    url: '/api/v1/workspaces/ws1',
    headers: { host: 'localhost' },
    method: 'DELETE',
  } as unknown as IncomingMessage
  ;(req as unknown as { on: (ev: string, cb: (...a: unknown[]) => void) => IncomingMessage }).on =
    () => req
  return req
}

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(payload?: string) {
      if (payload != null && payload.length > 0) {
        try {
          captured.body = JSON.parse(payload)
        } catch {
          captured.body = payload
        }
      }
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function stubState(deleted: boolean): GatewayState {
  return {
    deleteWorkspace: vi.fn().mockReturnValue(deleted),
  } as unknown as GatewayState
}

function stubRegistry(): TerminalSessionRegistry & {
  dropWorkspace: ReturnType<typeof vi.fn>
} {
  return {
    dropWorkspace: vi.fn(),
  } as unknown as TerminalSessionRegistry & {
    dropWorkspace: ReturnType<typeof vi.fn>
  }
}

describe('DELETE /api/v1/workspaces/:workspaceId — PTY cleanup', () => {
  it('calls registry.dropWorkspace BEFORE state.deleteWorkspace', async () => {
    const state = stubState(true)
    const registry = stubRegistry()
    const calls: string[] = []
    ;(registry.dropWorkspace as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('drop')
    })
    ;(state.deleteWorkspace as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('delete')
      return true
    })

    const { remove } = createWorkspaceHandlers(state, { terminalRegistry: registry })
    const { res, captured } = mockRes()
    await remove(mockReq(), res, { workspaceId: 'ws1' })

    expect(registry.dropWorkspace).toHaveBeenCalledWith('ws1')
    expect(state.deleteWorkspace).toHaveBeenCalledWith('ws1')
    expect(calls).toEqual(['drop', 'delete'])
    expect(captured.status).toBe(204)
  })

  it('returns 404 when workspace is unknown — but still attempted the drop (no-op)', async () => {
    const state = stubState(false)
    const registry = stubRegistry()
    const { remove } = createWorkspaceHandlers(state, { terminalRegistry: registry })
    const { res, captured } = mockRes()
    await remove(mockReq(), res, { workspaceId: 'ghost' })

    // Registry is called unconditionally — dropWorkspace is a no-op when
    // no PTYs exist for the id, so this is cheap and keeps the code
    // straight-line.
    expect(registry.dropWorkspace).toHaveBeenCalledWith('ghost')
    expect(captured.status).toBe(404)
  })

  it('succeeds when no registry is wired (legacy / test callers)', async () => {
    const state = stubState(true)
    const { remove } = createWorkspaceHandlers(state)
    const { res, captured } = mockRes()
    await remove(mockReq(), res, { workspaceId: 'ws1' })
    expect(state.deleteWorkspace).toHaveBeenCalledWith('ws1')
    expect(captured.status).toBe(204)
  })

  it('does not block the delete if dropWorkspace throws', async () => {
    const state = stubState(true)
    const registry = stubRegistry()
    ;(registry.dropWorkspace as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { remove } = createWorkspaceHandlers(state, { terminalRegistry: registry })
    const { res, captured } = mockRes()
    await remove(mockReq(), res, { workspaceId: 'ws1' })
    expect(state.deleteWorkspace).toHaveBeenCalledWith('ws1')
    expect(captured.status).toBe(204)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
