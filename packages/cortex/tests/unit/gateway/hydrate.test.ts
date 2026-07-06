/**
 * /api/v1/threads/:threadId/hydrate — one-shot thread open contract.
 *
 * The hydrate endpoint is the single entry point the client uses to open
 * any thread, live or archived. This suite pins the response shape so
 * no client has to care about the persistence plumbing underneath.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import { SessionRunner } from '../../../src/gateway/session-runner.js'
import { createThreadHandlers } from '../../../src/gateway/handlers/threads.js'

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    // Extract :threadId from /hydrate/:threadId
    const match = req.url!.match(/^\/hydrate\/([^?]+)/)
    if (!match) {
      res.writeHead(404)
      res.end()
      return
    }
    await handler(req, res, { threadId: match[1]! })
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, url }
}

describe('GET /threads/:id/hydrate', () => {
  let state: GatewayState
  let runner: SessionRunner
  let server: Server
  let url: string
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-hydrate-'))
    state = new GatewayState(join(tmpDir, 'ownware.db'))
    runner = new SessionRunner(state)
    const handlers = createThreadHandlers(state, { runner })
    const started = await startServer(handlers.hydrateThread)
    server = started.server
    url = started.url
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 404 for unknown thread', async () => {
    const res = await fetch(`${url}/hydrate/nope`)
    expect(res.status).toBe(404)
  })

  it('returns the full snapshot for an archived thread with runningAgentId=null', async () => {
    const thread = state.createThread('test', 'my thread')
    state.addMessage(thread.id, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    })
    state.addMessage(thread.id, {
      id: 'm2',
      role: 'assistant',
      content: 'hi back',
      tools: [{ name: 'echo', input: { x: 1 }, output: 'x=1', isError: false, durationMs: 3 }],
      usage: { inputTokens: 5, outputTokens: 5 },
      timestamp: new Date().toISOString(),
    })

    const res = await fetch(`${url}/hydrate/${thread.id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      thread: { id: string; title: string | null }
      messages: Array<{ id: string; role: string }>
      agents: unknown[]
      runningAgentId: string | null
      maxSeq: number
    }

    expect(body.thread.id).toBe(thread.id)
    expect(body.thread.title).toBe('my thread')
    expect(body.messages).toHaveLength(2)
    expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    // No active runner → runningAgentId is null, the client skips SSE.
    expect(body.runningAgentId).toBeNull()
    // No raw events were ingested in this setup.
    expect(body.maxSeq).toBe(0)
    expect(body.agents).toEqual([])
  })

  it('returns lastClosedTurnEndSeq for SSE reconnect cursor', async () => {
    const thread = state.createThread('test', 't')
    // Ingest a stream that mixes deltas and turn boundaries so the
    // last turn.end is the cursor we expect the client to use.
    const ingest = (event: { type: string; turnIndex?: number }) =>
      state.eventIngestor.ingestParentEvent(thread.id, event as unknown as import('@ownware/loom').LoomEvent)
    ingest({ type: 'turn.start', turnIndex: 0 })            // seq 1
    ingest({ type: 'text.delta', turnIndex: 0 })             // seq 2
    ingest({ type: 'turn.end', turnIndex: 0 })               // seq 3 ← lastClosedTurnEndSeq
    ingest({ type: 'turn.start', turnIndex: 1 })             // seq 4
    ingest({ type: 'text.delta', turnIndex: 1 })             // seq 5  (in-flight turn)

    const res = await fetch(`${url}/hydrate/${thread.id}`)
    const body = await res.json() as { maxSeq: number; lastClosedTurnEndSeq: number }
    expect(body.maxSeq).toBe(5)
    expect(body.lastClosedTurnEndSeq).toBe(3)
  })

  it('lastClosedTurnEndSeq is 0 when no turn has ever closed', async () => {
    const thread = state.createThread('test', 't')
    state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'turn.start', turnIndex: 0,
    } as unknown as import('@ownware/loom').LoomEvent)
    const res = await fetch(`${url}/hydrate/${thread.id}`)
    const body = await res.json() as { maxSeq: number; lastClosedTurnEndSeq: number }
    expect(body.maxSeq).toBe(1)
    expect(body.lastClosedTurnEndSeq).toBe(0)
  })

  it('reports runningAgentId="root" + live maxSeq while a run is in flight', async () => {
    const thread = state.createThread('test')
    // Simulate "a run is in flight" by pretending the runner holds a
    // run record for this thread. We can't easily plug a fake Session
    // into SessionRunner.start() here without reproducing the rest of
    // the runtime wiring — but isRunning is driven by the internal
    // `runs` Map which start() populates. Instead we drive it via the
    // event-ingestor directly to emulate the disk state and then flip
    // `isRunning` with a tiny shim.
    state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'text.delta', text: 'streaming', turnIndex: 0,
    } as unknown as import('@ownware/loom').LoomEvent)

    // Use a proxy runner that reports 'running'. This tests the handler
    // contract, not the runner internals.
    const livingRunner = {
      isRunning: (_tid: string) => true,
    } as unknown as SessionRunner
    const handlers2 = createThreadHandlers(state, { runner: livingRunner })
    const svr = await startServer(handlers2.hydrateThread)
    try {
      const res = await fetch(`${svr.url}/hydrate/${thread.id}`)
      const body = await res.json() as { runningAgentId: string | null; maxSeq: number }
      expect(body.runningAgentId).toBe('root')
      expect(body.maxSeq).toBeGreaterThan(0)
    } finally {
      await new Promise<void>(resolve => svr.server.close(() => resolve()))
    }
  })

  it('returns CredentialRecord[] + parts entry on a credential-bearing assistant row', async () => {
    // Regression for the "refresh-mid-credential = ugly subrow only" bug.
    // Before migration 013 the row had no credentials[] column and the
    // hydrated transcript lost the card entirely; the client's reducer fell
    // back to rendering just the `request_credential` tool subrow. This
    // test locks the new contract: the endpoint surfaces the full
    // CredentialRecord so the client can rebuild the CredentialChatItem.
    const thread = state.createThread('coder', 'with credential')
    state.addMessage(thread.id, {
      id: 'm-user',
      role: 'user',
      content: 'please fetch the admin list',
      timestamp: new Date().toISOString(),
    })
    state.addMessage(thread.id, {
      id: 'm-asst',
      role: 'assistant',
      content: '',
      tools: [{
        toolCallId: 'call_1',
        name: 'request_credential',
        input: { label: 'Admin JWT' },
        isError: false,
        durationMs: 1,
        output: 'stored',
      }],
      credentials: [{
        requestId: 'req-1',
        label: 'Admin JWT',
        hint: 'DevTools > localStorage > token',
        usage: 'Call /admin',
        placement: { type: 'bearer' },
        isRequired: true,
        decision: 'stored',
        credentialId: 'runtime.thread.ADMIN_JWT',
      }],
      parts: [
        { kind: 'tool', toolCallId: 'call_1' },
        { kind: 'credential', requestId: 'req-1' },
      ],
      timestamp: new Date().toISOString(),
    })

    const res = await fetch(`${url}/hydrate/${thread.id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      messages: Array<{
        role: string
        credentials?: Array<{ requestId: string; decision: string; credentialId?: string }>
        parts?: Array<{ kind: string; requestId?: string }>
      }>
    }
    const assistant = body.messages.find(m => m.role === 'assistant')!
    expect(assistant.credentials).toBeDefined()
    expect(assistant.credentials).toHaveLength(1)
    expect(assistant.credentials![0]!.requestId).toBe('req-1')
    expect(assistant.credentials![0]!.decision).toBe('stored')
    expect(assistant.credentials![0]!.credentialId).toBe('runtime.thread.ADMIN_JWT')
    const credPart = assistant.parts?.find(p => p.kind === 'credential')
    expect(credPart?.requestId).toBe('req-1')
  })
})
