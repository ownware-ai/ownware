import { describe, it, expect } from 'vitest'
import {
  interpretSseEvent,
  parseSseFrames,
  HttpGatewayClient,
  type RunStreamEvent,
} from '../gateway-client.js'

/** A ReadableStream<Uint8Array> from a string, for feeding the SSE parser. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('interpretSseEvent — terminal detection', () => {
  it('maps text.delta to a delta event', () => {
    expect(interpretSseEvent('text.delta', { type: 'text.delta', text: 'hi', seq: 3 }, 0)).toEqual({
      event: { type: 'delta', text: 'hi', seq: 3 },
      stop: false,
      seq: 3,
    })
  })

  it('does NOT end the run on a tool_use turn.end (loop continues)', () => {
    const r = interpretSseEvent('turn.end', { type: 'turn.end', stopReason: 'tool_use', seq: 5 }, 0)
    expect(r.stop).toBe(false)
    expect(r.event).toBeUndefined()
  })

  it('does NOT end the run on a pause_turn turn.end', () => {
    expect(interpretSseEvent('turn.end', { type: 'turn.end', stopReason: 'pause_turn', seq: 5 }, 0).stop).toBe(false)
  })

  it('ends the run on a terminal turn.end (end_turn)', () => {
    const r = interpretSseEvent('turn.end', { type: 'turn.end', stopReason: 'end_turn', seq: 9 }, 0)
    expect(r).toEqual({ event: { type: 'done', seq: 9 }, stop: true, seq: 9 })
  })

  it('ends on turn.interrupted, error, and stream.shutdown', () => {
    expect(interpretSseEvent('turn.interrupted', { type: 'turn.interrupted', reason: 'aborted', seq: 4 }, 0).stop).toBe(true)
    expect(interpretSseEvent('error', { type: 'error', message: 'boom', seq: 4 }, 0)).toEqual({
      event: { type: 'error', message: 'boom', seq: 4 },
      stop: true,
      seq: 4,
    })
    expect(interpretSseEvent('stream.shutdown', { type: 'stream.shutdown', reason: 'slow_consumer', seq: 4 }, 0).stop).toBe(true)
  })

  it('ignores unrelated events (tool/thinking/cache) and carries the cursor', () => {
    const r = interpretSseEvent('tool.call.start', { type: 'tool.call.start', seq: 7 }, 2)
    expect(r.event).toBeUndefined()
    expect(r.stop).toBe(false)
    expect(r.seq).toBe(7)
  })
})

describe('parseSseFrames', () => {
  it('parses event/data frames and JSON-decodes data', async () => {
    const wire =
      'event: text.delta\ndata: {"type":"text.delta","text":"hello","seq":1}\n\n' +
      ':keepalive\n\n' +
      'event: turn.end\ndata: {"type":"turn.end","stopReason":"end_turn","seq":2}\n\n'
    const frames: Array<{ event: string; data: unknown }> = []
    for await (const f of parseSseFrames(streamOf(wire))) frames.push(f)
    expect(frames).toHaveLength(2)
    expect(frames[0]?.event).toBe('text.delta')
    expect((frames[0]?.data as { text: string }).text).toBe('hello')
    expect(frames[1]?.event).toBe('turn.end')
  })
})

describe('HttpGatewayClient (injected fetch)', () => {
  it('run() POSTs to /api/v1/run with prompt+profileId and returns threadId', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ threadId: 't-123', agentId: 'root' }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new HttpGatewayClient({ baseUrl: 'http://gw:3011/', token: 'secret', fetch: fakeFetch })
    const res = await client.run({ profileId: 'acme', prompt: 'hi' })

    expect(res.threadId).toBe('t-123')
    expect(calls[0]?.url).toBe('http://gw:3011/api/v1/run')
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer secret')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ prompt: 'hi', profileId: 'acme' })
  })

  it('streamReply() yields deltas then done from the SSE body, then stops', async () => {
    const wire =
      'event: text.delta\ndata: {"type":"text.delta","text":"Hel","seq":1}\n\n' +
      'event: text.delta\ndata: {"type":"text.delta","text":"lo","seq":2}\n\n' +
      'event: turn.end\ndata: {"type":"turn.end","stopReason":"end_turn","seq":3}\n\n'
    const fakeFetch = (async () => new Response(streamOf(wire), { status: 200 })) as unknown as typeof fetch

    const client = new HttpGatewayClient({ baseUrl: 'http://gw:3011', fetch: fakeFetch })
    const events: RunStreamEvent[] = []
    for await (const ev of client.streamReply('t-123', { since: 0 })) events.push(ev)

    expect(events).toEqual([
      { type: 'delta', text: 'Hel', seq: 1 },
      { type: 'delta', text: 'lo', seq: 2 },
      { type: 'done', seq: 3 },
    ])
  })
})
