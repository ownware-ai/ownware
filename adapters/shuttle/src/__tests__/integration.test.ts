import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { HttpGatewayClient, type RunStreamEvent } from '../gateway-client.js'
import { ShuttleAdapter } from '../adapter.js'
import { InMemoryThreadMap } from '../thread-map.js'
import type { ChannelTransport } from '../delivery.js'

/**
 * Integration: exercise HttpGatewayClient + the base adapter against a REAL
 * HTTP server over a REAL socket with the REAL global fetch — the layer the
 * unit tests mock. This catches streaming / SSE-framing / fetch-body issues a
 * synthetic Response can't. It mimics the ownware gateway's /run + agent-events SSE
 * contract (including root-SSE staying OPEN after the terminal turn.end, so the
 * client must close it itself).
 */

let sawStreamClose = false

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? ''
  if (req.method === 'POST' && url === '/api/v1/run') {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      JSON.parse(body) // assert it's valid JSON
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ threadId: 't-int', agentId: 'root', status: 'running' }))
    })
    return
  }
  if (req.method === 'GET' && url.startsWith('/api/v1/threads/t-int/agents/root/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    // stream two deltas + a terminal turn.end, as separate writes (real chunking)
    res.write(`event: text.delta\ndata: ${JSON.stringify({ type: 'text.delta', text: 'hello ', seq: 1 })}\n\n`)
    res.write(`event: text.delta\ndata: ${JSON.stringify({ type: 'text.delta', text: 'world', seq: 2 })}\n\n`)
    res.write(`event: turn.end\ndata: ${JSON.stringify({ type: 'turn.end', stopReason: 'end_turn', seq: 3 })}\n\n`)
    // Deliberately DO NOT end — root SSE stays open. The client must cancel.
    res.on('close', () => {
      sawStreamClose = true
    })
    return
  }
  res.writeHead(404)
  res.end()
}

class RecordingTransport implements ChannelTransport {
  readonly sent: string[] = []
  readonly maxChars = 4096
  readonly supportsEdit = false
  readonly supportsTyping = false
  async sendText(_t: string, text: string): Promise<string | undefined> {
    this.sent.push(text)
    return undefined
  }
  async editText(): Promise<void> {}
  async sendTyping(): Promise<void> {}
}

describe('integration: HttpGatewayClient over a real socket', () => {
  let server: Server
  let baseUrl = ''

  beforeAll(async () => {
    server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('run() then streamReply() work over real HTTP + SSE and close on terminal turn.end', async () => {
    const client = new HttpGatewayClient({ baseUrl })
    const { threadId } = await client.run({ profileId: 'x', prompt: 'hi' })
    expect(threadId).toBe('t-int')

    const events: RunStreamEvent[] = []
    for await (const ev of client.streamReply(threadId, { since: 0 })) events.push(ev)

    expect(events).toEqual([
      { type: 'delta', text: 'hello ', seq: 1 },
      { type: 'delta', text: 'world', seq: 2 },
      { type: 'done', seq: 3 },
    ])
  })

  it('the base adapter drives the real gateway and delivers the combined reply back', async () => {
    const transport = new RecordingTransport()
    const adapter = new ShuttleAdapter(
      { profileId: 'x', channel: 'itest', delivery: { mode: 'final' } },
      { gateway: new HttpGatewayClient({ baseUrl }), threads: new InMemoryThreadMap(), transport },
    )

    const result = await adapter.handle({ chatType: 'dm', chatId: '1', target: 'dest', text: 'hi' })

    expect(transport.sent).toEqual(['hello world']) // deltas collected into the final message
    expect(result?.text).toBe('hello world')
    // give the client's stream-cancel a tick to reach the server
    await new Promise((r) => setTimeout(r, 20))
    expect(sawStreamClose).toBe(true) // client closed the still-open root SSE
  })
})
