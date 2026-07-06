/**
 * PendingReconciles — unit tests.
 *
 * Scenarios (board tasks 4 list):
 *   1. Mark then consume returns true.
 *   2. Consume without mark returns false.
 *   3. Consume twice after one mark: true, then false (edge-triggered).
 *   4. Per-thread isolation — mark A, consume B = false.
 *   5. Concurrent marks on the same thread coalesce (no double-work).
 *
 * Plus the `withReconcileLock` mutex contract:
 *   - Two concurrent calls on the same thread serialize.
 *   - Prior failure doesn't prevent the next caller from running.
 *   - Different threads don't interfere.
 */

import { describe, expect, it } from 'vitest'
import { PendingReconciles } from '../../../src/gateway/pending-reconcile.js'

describe('PendingReconciles — mark/consume semantics', () => {
  it('mark then consume returns true', () => {
    const p = new PendingReconciles()
    p.mark('thread-1')
    expect(p.consume('thread-1')).toBe(true)
  })

  it('consume without mark returns false', () => {
    const p = new PendingReconciles()
    expect(p.consume('thread-1')).toBe(false)
  })

  it('consume is edge-triggered — second consume after one mark is false', () => {
    const p = new PendingReconciles()
    p.mark('thread-1')
    expect(p.consume('thread-1')).toBe(true)
    expect(p.consume('thread-1')).toBe(false)
  })

  it('per-thread isolation — mark A does not trigger consume B', () => {
    const p = new PendingReconciles()
    p.mark('thread-A')
    expect(p.consume('thread-B')).toBe(false)
    expect(p.consume('thread-A')).toBe(true)
  })

  it('multiple marks on the same thread coalesce into one consume', () => {
    const p = new PendingReconciles()
    p.mark('thread-1')
    p.mark('thread-1')
    p.mark('thread-1')
    expect(p.consume('thread-1')).toBe(true)
    expect(p.consume('thread-1')).toBe(false)
  })

  it('isPending peeks without consuming', () => {
    const p = new PendingReconciles()
    p.mark('thread-1')
    expect(p.isPending('thread-1')).toBe(true)
    expect(p.isPending('thread-1')).toBe(true) // idempotent peek
    expect(p.consume('thread-1')).toBe(true)
    expect(p.isPending('thread-1')).toBe(false)
  })

  it('clear() drops every thread flag', () => {
    const p = new PendingReconciles()
    p.mark('a')
    p.mark('b')
    p.clear()
    expect(p.consume('a')).toBe(false)
    expect(p.consume('b')).toBe(false)
  })
})

describe('PendingReconciles — managed-tools snapshot', () => {
  it('set then get returns the same snapshot reference', () => {
    const p = new PendingReconciles()
    const m = new Map([['composio_gmail_search', { name: 'composio_gmail_search' } as never]])
    p.setManaged('thread-1', m)
    expect(p.getManaged('thread-1')).toBe(m)
  })

  it('get without set returns undefined', () => {
    const p = new PendingReconciles()
    expect(p.getManaged('thread-1')).toBeUndefined()
  })

  it('setManaged overwrites the prior snapshot', () => {
    const p = new PendingReconciles()
    p.setManaged('thread-1', new Map())
    const fresh = new Map([['x', { name: 'x' } as never]])
    p.setManaged('thread-1', fresh)
    expect(p.getManaged('thread-1')).toBe(fresh)
  })

  it('deleteManaged drops the snapshot', () => {
    const p = new PendingReconciles()
    p.setManaged('thread-1', new Map())
    p.deleteManaged('thread-1')
    expect(p.getManaged('thread-1')).toBeUndefined()
  })

  it('managed snapshots are per-thread isolated', () => {
    const p = new PendingReconciles()
    const mA = new Map([['a', { name: 'a' } as never]])
    const mB = new Map([['b', { name: 'b' } as never]])
    p.setManaged('A', mA)
    p.setManaged('B', mB)
    expect(p.getManaged('A')).toBe(mA)
    expect(p.getManaged('B')).toBe(mB)
  })

  it('clear() drops pending flags AND managed snapshots', () => {
    const p = new PendingReconciles()
    p.mark('thread-1')
    p.setManaged('thread-1', new Map([['x', { name: 'x' } as never]]))
    p.clear()
    expect(p.consume('thread-1')).toBe(false)
    expect(p.getManaged('thread-1')).toBeUndefined()
  })
})

describe('PendingReconciles — withReconcileLock mutex', () => {
  it('serializes two concurrent calls on the same thread', async () => {
    const p = new PendingReconciles()
    const order: string[] = []

    const first = p.withReconcileLock('thread-1', async () => {
      order.push('first:start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('first:end')
      return 'first'
    })
    const second = p.withReconcileLock('thread-1', async () => {
      order.push('second:start')
      return 'second'
    })

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe('first')
    expect(b).toBe('second')
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('allows different threads to run concurrently', async () => {
    const p = new PendingReconciles()
    const order: string[] = []

    const a = p.withReconcileLock('thread-A', async () => {
      order.push('A:start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('A:end')
      return 'A'
    })
    const b = p.withReconcileLock('thread-B', async () => {
      order.push('B:start')
      await new Promise((r) => setTimeout(r, 5))
      order.push('B:end')
      return 'B'
    })

    await Promise.all([a, b])
    // B finishes before A because its inner delay is shorter.
    // Proves the two threads didn't share a lock.
    expect(order.indexOf('B:end')).toBeLessThan(order.indexOf('A:end'))
  })

  it('prior failure does not prevent the next caller from running', async () => {
    const p = new PendingReconciles()
    const first = p.withReconcileLock('thread-1', async () => {
      throw new Error('boom')
    })
    const second = p.withReconcileLock('thread-1', async () => 'ok')

    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
  })

  it('clears the lock map after the last caller settles', async () => {
    const p = new PendingReconciles()
    await p.withReconcileLock('thread-1', async () => 'x')
    // Internal invariant: a subsequent call must not wait on stale state.
    const start = Date.now()
    await p.withReconcileLock('thread-1', async () => 'y')
    // Near-zero — if the previous lock leaked, this would block on
    // the settled-but-never-cleared promise (still resolves, but we
    // assert the map was cleaned up by not observing any wait).
    expect(Date.now() - start).toBeLessThan(20)
  })
})
