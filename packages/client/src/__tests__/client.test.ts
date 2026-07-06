/**
 * OwnwareClient — unit tests against an in-process fake gateway.
 *
 * Pins the transport contract without booting cortex:
 *   - request shapes (paths, bodies, Bearer header on EVERY call)
 *   - streamReply's termination rules (the root SSE never closes)
 *   - the seq/since resume cursor
 *   - error propagation on non-OK responses
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { OwnwareClient } from '../client.js'

interface Seen {
  method: string
  url: string
  auth: string | undefined
  body: string
}

let server: Server
let baseUrl: string
const seen: Seen[] = []

/** SSE frames the fake gateway plays for any events request. */
let sseScript: Array<Record<string, unknown>> = []

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    })

    const url = req.url ?? ''
    if (url.startsWith('/api/v1/run')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ threadId: 't_1', agentId: 'root', model: 'ollama:llama3.2', status: 'running' }))
      return
    }
    if (/\/agents\/root\/events/.test(url)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(':keepalive\n\n')
      for (const ev of sseScript) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      // Leave the socket open — the root SSE never closes; the CLIENT
      // must decide the reply is finished and hang up.
      return
    }
    if (/\/resume$/.test(url) || /\/abort$/.test(url)) {
      if (url.includes('/threads/missing/')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Thread "missing" not found' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (url.startsWith('/api/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'ollama:llama3.2', provider: 'ollama', hasCredentials: true, default: true }]))
      return
    }
    if (url.startsWith('/api/v1/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', version: '0.0.0' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'nope' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
})

function client(): OwnwareClient {
  return new OwnwareClient({ baseUrl, token: 'tok123' })
}

describe('request shapes', () => {
  it('run() POSTs the body and returns the full result', async () => {
    const result = await client().run({ profileId: 'assistant', prompt: 'hi', threadId: 't_1', model: 'x:y' })
    expect(result.threadId).toBe('t_1')
    expect(result.model).toBe('ollama:llama3.2')
    const last = seen[seen.length - 1]!
    expect(last.method).toBe('POST')
    expect(last.url).toBe('/api/v1/run')
    expect(JSON.parse(last.body)).toEqual({ prompt: 'hi', profileId: 'assistant', threadId: 't_1', model: 'x:y' })
  })

  it('every call carries the Bearer token — including the SSE request', async () => {
    sseScript = [{ type: 'turn.end', stopReason: 'end_turn', seq: 1 }]
    const events = []
    for await (const ev of client().streamReply('t_1')) events.push(ev)
    for (const call of seen.slice(-1)) expect(call.auth).toBe('Bearer tok123')

    await client().resume('t_1', { action: 'approve', requestId: 'r1' })
    let last = seen[seen.length - 1]!
    expect(last.url).toBe('/api/v1/threads/t_1/resume')
    expect(JSON.parse(last.body)).toEqual({ action: 'approve', requestId: 'r1' })
    expect(last.auth).toBe('Bearer tok123')

    await client().abort('t_1')
    last = seen[seen.length - 1]!
    expect(last.url).toBe('/api/v1/threads/t_1/abort')
    expect(last.auth).toBe('Bearer tok123')

    const models = await client().models()
    expect(models[0]!.id).toBe('ollama:llama3.2')
    expect(seen[seen.length - 1]!.auth).toBe('Bearer tok123')

    const health = await client().health()
    expect(health.status).toBe('ok')
  })

  it('streamReply passes the since cursor on the URL', async () => {
    sseScript = [{ type: 'turn.end', stopReason: 'end_turn', seq: 10 }]
    for await (const _ of client().streamReply('t_1', { since: 7 })) {
      /* drain */
    }
    const sse = seen.filter((s) => s.url.includes('/events')).pop()!
    expect(sse.url).toContain('since=7')
  })

  it('a non-OK response throws with status and body text', async () => {
    const bad = new OwnwareClient({ baseUrl })
    await expect(bad.resume('missing', { action: 'deny' })).rejects.toThrow(/404/)
  })
})

describe('streamReply termination (the root SSE never closes)', () => {
  it('deltas stream, tool_use turn.end continues, terminal turn.end finishes', async () => {
    sseScript = [
      { type: 'text.delta', text: 'Hel', seq: 1 },
      { type: 'turn.end', stopReason: 'tool_use', seq: 2 },
      { type: 'text.delta', text: 'lo', seq: 3 },
      { type: 'turn.end', stopReason: 'end_turn', seq: 4 },
      { type: 'text.delta', text: 'NEVER SEEN', seq: 5 },
    ]
    const got: string[] = []
    let done = false
    for await (const ev of client().streamReply('t_1')) {
      if (ev.type === 'delta') got.push(ev.text)
      if (ev.type === 'done') done = true
    }
    expect(got.join('')).toBe('Hello')
    expect(done).toBe(true)
  })

  it('an error event terminates with type error', async () => {
    sseScript = [
      { type: 'text.delta', text: 'x', seq: 1 },
      { type: 'error', message: 'provider exploded', seq: 2 },
    ]
    const types: string[] = []
    for await (const ev of client().streamReply('t_1')) types.push(ev.type)
    expect(types).toEqual(['delta', 'error'])
  })

  it('events() yields the RAW vocabulary and does not stop at terminal turn.end', async () => {
    sseScript = [
      { type: 'tool.call.start', toolName: 'web_search', seq: 1 },
      { type: 'turn.end', stopReason: 'end_turn', seq: 2 },
      { type: 'permission.request', toolName: 'shell', seq: 3 },
    ]
    const types: string[] = []
    for await (const ev of client().events('t_1')) {
      types.push(ev.type)
      if (types.length === 3) break // raw stream never self-terminates — caller breaks
    }
    expect(types).toEqual(['tool.call.start', 'turn.end', 'permission.request'])
  })
})
