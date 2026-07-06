import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HumanInTheLoop } from '../../../src/permissions/hitl.js'
import type { ApprovalRequest } from '../../../src/permissions/hitl.js'
import type { ToolCall } from '../../../src/tools/types.js'

function makeToolCall(name = 'shell', id = 'call_1'): ToolCall {
  return { id, name, input: { command: 'ls' } }
}

describe('HumanInTheLoop', () => {
  let hitl: HumanInTheLoop

  afterEach(() => {
    hitl?.dispose()
  })

  describe('no handler registered', () => {
    it('defaults to deny when no handler', async () => {
      hitl = new HumanInTheLoop()
      const approved = await hitl.requestApproval(makeToolCall())
      expect(approved).toBe(false)
    })
  })

  describe('with handler', () => {
    it('approves when handler auto-approves via respond', async () => {
      hitl = new HumanInTheLoop()
      hitl.onApprovalNeeded((request: ApprovalRequest) => {
        hitl.respond(request.requestId, true)
      })

      const approved = await hitl.requestApproval(makeToolCall())
      expect(approved).toBe(true)
    })

    it('denies when handler denies via respond', async () => {
      hitl = new HumanInTheLoop()
      hitl.onApprovalNeeded((request: ApprovalRequest) => {
        hitl.respond(request.requestId, false)
      })

      const approved = await hitl.requestApproval(makeToolCall())
      expect(approved).toBe(false)
    })

    it('passes correct request info to handler', async () => {
      hitl = new HumanInTheLoop()
      let receivedRequest: ApprovalRequest | null = null

      hitl.onApprovalNeeded((request: ApprovalRequest) => {
        receivedRequest = request
        hitl.respond(request.requestId, true)
      })

      await hitl.requestApproval(makeToolCall('shell', 'call_xyz'), 'Test reason')
      expect(receivedRequest).toBeDefined()
      expect(receivedRequest!.requestId).toBe('call_xyz')
      expect(receivedRequest!.toolCall.name).toBe('shell')
      expect(receivedRequest!.reason).toBe('Test reason')
      expect(receivedRequest!.timestamp).toBeGreaterThan(0)
    })
  })

  describe('timeout', () => {
    it('denies after timeout', async () => {
      hitl = new HumanInTheLoop({ timeoutMs: 50 })
      hitl.onApprovalNeeded(() => {
        // Don't respond — let it timeout
      })

      const approved = await hitl.requestApproval(makeToolCall())
      expect(approved).toBe(false)
    })
  })

  describe('removeHandler', () => {
    it('reverts to deny after removing handler', async () => {
      hitl = new HumanInTheLoop()
      hitl.onApprovalNeeded((req) => hitl.respond(req.requestId, true))
      hitl.removeHandler()

      const approved = await hitl.requestApproval(makeToolCall())
      expect(approved).toBe(false)
    })
  })

  describe('pendingCount', () => {
    it('tracks pending requests', () => {
      hitl = new HumanInTheLoop()
      expect(hitl.pendingCount).toBe(0)

      hitl.onApprovalNeeded(() => {
        // Don't respond
      })

      // Fire and forget — don't await
      hitl.requestApproval(makeToolCall('a', 'id1'))
      hitl.requestApproval(makeToolCall('b', 'id2'))

      // Wait a tick for promises to schedule
      return new Promise<void>(resolve => {
        setTimeout(() => {
          expect(hitl.pendingCount).toBe(2)
          hitl.respond('id1', true)
          expect(hitl.pendingCount).toBe(1)
          resolve()
        }, 10)
      })
    })
  })

  describe('approveAll', () => {
    it('approves all pending requests', async () => {
      hitl = new HumanInTheLoop()
      hitl.onApprovalNeeded(() => {
        // Don't respond individually
      })

      const p1 = hitl.requestApproval(makeToolCall('a', 'id1'))
      const p2 = hitl.requestApproval(makeToolCall('b', 'id2'))

      // Wait a tick then approve all
      await new Promise(resolve => setTimeout(resolve, 10))
      hitl.approveAll()

      expect(await p1).toBe(true)
      expect(await p2).toBe(true)
      expect(hitl.pendingCount).toBe(0)
    })
  })

  describe('denyAll', () => {
    it('denies all pending requests', async () => {
      hitl = new HumanInTheLoop()
      hitl.onApprovalNeeded(() => {
        // Don't respond individually
      })

      const p1 = hitl.requestApproval(makeToolCall('a', 'id1'))
      const p2 = hitl.requestApproval(makeToolCall('b', 'id2'))

      await new Promise(resolve => setTimeout(resolve, 10))
      hitl.denyAll()

      expect(await p1).toBe(false)
      expect(await p2).toBe(false)
      expect(hitl.pendingCount).toBe(0)
    })
  })

  describe('dispose', () => {
    it('denies all pending and removes listeners', async () => {
      hitl = new HumanInTheLoop()
      hitl.onApprovalNeeded(() => {})

      const p = hitl.requestApproval(makeToolCall())
      await new Promise(resolve => setTimeout(resolve, 10))
      hitl.dispose()

      expect(await p).toBe(false)
      expect(hitl.pendingCount).toBe(0)
    })
  })

  describe('respond to unknown requestId', () => {
    it('is a no-op', () => {
      hitl = new HumanInTheLoop()
      // Should not throw
      hitl.respond('nonexistent', true)
    })
  })
})
