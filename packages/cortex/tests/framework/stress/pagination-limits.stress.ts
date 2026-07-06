/**
 * Stress: Pagination limits
 *
 * Create 500 threads, verify pagination works at scale.
 *   - Default limit
 *   - Max limit (200)
 *   - Cap when limit > 200
 *   - Offset paging through entire dataset
 *   - Offset beyond total returns empty + correct total
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Stress: Pagination limits', () => {
  let gw: TestGateway
  const TOTAL = 500

  beforeAll(async () => {
    gw = await createTestGateway({
      seed: (state) => {
        for (let i = 0; i < TOTAL; i++) {
          state.createThread('mini', `Stress thread ${i}`)
        }
      },
    })
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it(`Total threads = ${TOTAL}`, () => {
    expect(gw.state.threadCount).toBe(TOTAL)
  })

  it('Default limit returns 50 items', () => {
    const result = gw.state.listThreads()
    expect(result.items.length).toBe(50)
    expect(result.total).toBe(TOTAL)
    expect(result.limit).toBe(50)
  })

  it('Max limit (200) returns 200 items', () => {
    const result = gw.state.listThreads(undefined, { limit: 200 })
    expect(result.items.length).toBe(200)
    expect(result.limit).toBe(200)
  })

  it('Limit > 200 is capped at 200', () => {
    const result = gw.state.listThreads(undefined, { limit: 999 })
    expect(result.items.length).toBe(200)
    expect(result.limit).toBe(200)
  })

  it('Offset paging through entire dataset visits all threads', () => {
    const seen = new Set<string>()
    const limit = 200
    for (let offset = 0; offset < TOTAL; offset += limit) {
      const result = gw.state.listThreads(undefined, { limit, offset })
      for (const t of result.items) seen.add(t.id)
    }
    expect(seen.size).toBe(TOTAL)
  })

  it('No duplicates across pages', () => {
    const limit = 100
    const allIds: string[] = []
    for (let offset = 0; offset < TOTAL; offset += limit) {
      const result = gw.state.listThreads(undefined, { limit, offset })
      for (const t of result.items) allIds.push(t.id)
    }
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('Offset = TOTAL returns empty items, correct total', () => {
    const result = gw.state.listThreads(undefined, { limit: 50, offset: TOTAL })
    expect(result.items.length).toBe(0)
    expect(result.total).toBe(TOTAL)
  })

  it('Offset > TOTAL returns empty items, correct total', () => {
    const result = gw.state.listThreads(undefined, { limit: 50, offset: TOTAL + 1000 })
    expect(result.items.length).toBe(0)
    expect(result.total).toBe(TOTAL)
  })

  it('GET /threads via HTTP returns paginated result with correct total', async () => {
    const r = await gw.client.get<{ items: unknown[]; total: number }>('/api/v1/threads')
    expect(r.body.total).toBe(TOTAL)
    expect(r.body.items.length).toBe(50) // default limit
  })
})
