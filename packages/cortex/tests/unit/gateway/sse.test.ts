/**
 * Unit tests for SSE helpers.
 */

import { describe, it, expect, vi } from 'vitest'
import { startSSE, writeSSE } from '../../../src/gateway/sse.js'
import type { ServerResponse } from 'node:http'

function createMockResponse(): { res: ServerResponse; chunks: string[] } {
  const chunks: string[] = []
  const res = {
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((data: string) => { chunks.push(data); return true }),
    end: vi.fn(() => { (res as any).writableEnded = true }),
    on: vi.fn(),
    once: vi.fn(),
  } as unknown as ServerResponse

  return { res, chunks }
}

describe('startSSE', () => {
  it('sets correct headers', () => {
    const { res } = createMockResponse()
    startSSE(res)
    // No 'Connection' header: it is the implicit default on HTTP/1.1 and is
    // FORBIDDEN on HTTP/2 (writeHead would throw). The gateway serves SSE over
    // HTTP/2 (see gateway/CLAUDE.md + sse.ts), so startSSE deliberately omits
    // it and sets X-Accel-Buffering instead. Assert what it ACTUALLY sets.
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    }))
  })
})

describe('writeSSE', () => {
  it('writes event in SSE format', async () => {
    const { res, chunks } = createMockResponse()
    await writeSSE(res, 'test.event', { hello: 'world' })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('event: test.event\ndata: {"hello":"world"}\n\n')
  })

  it('does not write if stream ended', async () => {
    const { res, chunks } = createMockResponse()
    ;(res as any).writableEnded = true
    await writeSSE(res, 'test', { data: true })
    expect(chunks).toHaveLength(0)
  })

  it('serializes complex objects', async () => {
    const { res, chunks } = createMockResponse()
    await writeSSE(res, 'data', { nested: { array: [1, 2, 3] } })
    expect(chunks[0]).toContain('"nested"')
    expect(chunks[0]).toContain('[1,2,3]')
  })
})
