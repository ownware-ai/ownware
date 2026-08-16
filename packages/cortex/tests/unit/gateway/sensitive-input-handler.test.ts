import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '@ownware/loom'
import type { GatewayState } from '../../../src/gateway/state.js'
import type { RunRepository } from '../../../src/storage/security-repositories.js'
import { SENSITIVE_INPUT_MAX_BYTES } from '../../../src/gateway/types.js'
import { createSensitiveInputHandlers } from '../../../src/gateway/handlers/sensitive-input.js'
import {
  SensitiveInputBroker,
  type SensitiveInputAdapter,
} from '../../../src/gateway/sensitive-input-broker.js'

const runId = '11111111-1111-4111-8111-111111111111'
const requestId = 'request-1'
const threadId = 'thread-1'

function trustedTool(): Tool {
  return {
    name: 'trusted_sensitive_tool',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: 'unused', isError: false }),
  }
}

function fixture() {
  const inject = vi.fn(async () => ({ disposition: 'applied' as const }))
  const tool = trustedTool()
  const adapter: SensitiveInputAdapter<{ kind: string; revision: string }> = {
    contractRevision: 'test.inject.v1',
    prepare: binding => Object.freeze({ ...binding }),
    inject,
  }
  const broker = new SensitiveInputBroker({ issueToken: () => 'handle-1' })
  broker.register(tool, adapter)
  broker.beginRun(runId)
  const start = broker.request({
    requestId,
    toolCallId: 'call-1',
    toolName: tool.name,
    agentId: null,
    tool,
    request: {
      label: 'Password',
      usage: 'Sign in',
      binding: { kind: 'test-target', revision: 'test.inject.v1' },
    },
  })
  if (start.status !== 'pending') throw new Error('expected pending')

  const state = {
    getSessionCompanions: (candidate: string) =>
      candidate === threadId ? { sensitiveInputBroker: broker } : undefined,
    securityRepositories: {
      threadBindings: { allows: vi.fn().mockResolvedValue(true) },
    },
  } as unknown as GatewayState
  const runStore = {
    get: vi.fn().mockResolvedValue({
      runId,
      threadId,
      workspaceId: null,
      profileId: 'profile-1',
      status: 'waiting',
      terminal: false,
    }),
  } as unknown as RunRepository
  return {
    broker,
    inject,
    provision: start.provision,
    handlers: createSensitiveInputHandlers(state, runStore),
  }
}

describe('sensitive-input HTTP handler', () => {
  it('accepts bounded text/plain once, never echoes it, and preserves no-store', async () => {
    const secret = 'direct-secret-秘密'
    const { handlers, provision, broker, inject } = fixture()
    const res = response()

    await handlers.submit(request(Buffer.from(secret), 'text/plain; charset=utf-8'), res, {
      runId,
      requestId,
    })

    expect(res.capture.status).toBe(200)
    expect(res.capture.headers.get('cache-control')).toBe('no-store')
    expect(JSON.stringify(res.capture.body)).not.toContain(secret)
    expect(res.capture.body).toEqual({ runId, requestId, accepted: true, status: 'provided' })
    const supplied = await provision
    if (supplied.status !== 'provided') throw new Error('expected handle')
    await expect(broker.consume(supplied.handle)).resolves.toEqual({ status: 'injected' })
    expect(inject).toHaveBeenCalledWith(
      { kind: 'test-target', revision: 'test.inject.v1' },
      secret,
    )

    const replay = response()
    await handlers.submit(request(Buffer.from('another'), 'text/plain'), replay, {
      runId,
      requestId,
    })
    expect(replay.capture.status).toBe(409)
  })

  it('rejects non-text media and malformed UTF-8 while leaving the request pending', async () => {
    const media = fixture()
    const mediaResponse = response()
    await media.handlers.submit(request(Buffer.from('secret'), 'application/json'), mediaResponse, {
      runId,
      requestId,
    })
    expect(mediaResponse.capture.status).toBe(415)
    expect(media.broker.getPending(runId, requestId)).toBeDefined()

    const malformed = fixture()
    const malformedResponse = response()
    await malformed.handlers.submit(
      request(Buffer.from([0xc3, 0x28]), 'text/plain'),
      malformedResponse,
      { runId, requestId },
    )
    expect(malformedResponse.capture.status).toBe(400)
    expect(malformed.broker.getPending(runId, requestId)).toBeDefined()
  })

  it('rejects empty and oversized values without consuming the request', async () => {
    const empty = fixture()
    const emptyResponse = response()
    await empty.handlers.submit(request(Buffer.alloc(0), 'text/plain'), emptyResponse, {
      runId,
      requestId,
    })
    expect(emptyResponse.capture.status).toBe(400)
    expect(empty.broker.getPending(runId, requestId)).toBeDefined()

    const oversized = fixture()
    const oversizedResponse = response()
    await oversized.handlers.submit(
      request(Buffer.alloc(SENSITIVE_INPUT_MAX_BYTES + 1, 0x61), 'text/plain'),
      oversizedResponse,
      { runId, requestId },
    )
    expect(oversizedResponse.capture.status).toBe(413)
    expect(oversized.broker.getPending(runId, requestId)).toBeDefined()
  })

  it('declines one pending request without a value body', async () => {
    const { handlers, provision } = fixture()
    const res = response()
    await handlers.deny(request(Buffer.alloc(0)), res, { runId, requestId })

    expect(res.capture.status).toBe(200)
    expect(res.capture.body).toEqual({ runId, requestId, accepted: true, status: 'denied' })
    await expect(provision).resolves.toEqual({ status: 'denied' })
  })
})

function request(body: Buffer, contentType?: string): IncomingMessage {
  const req = Readable.from(body.byteLength === 0 ? [] : [body]) as unknown as IncomingMessage
  const headers: Record<string, string> = {
    host: 'localhost',
    'content-length': String(body.byteLength),
  }
  if (contentType !== undefined) headers['content-type'] = contentType
  ;(req as unknown as { headers: Record<string, string> }).headers = headers
  ;(req as unknown as { method: string }).method = 'POST'
  return req
}

interface CapturedResponse extends ServerResponse {
  readonly capture: {
    readonly status: number
    readonly headers: ReadonlyMap<string, string>
    readonly body: unknown
  }
}

function response(): CapturedResponse {
  let status = 200
  let body: unknown
  const headers = new Map<string, string>()
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), String(value))
      return res
    },
    writeHead(nextStatus: number, nextHeaders?: OutgoingHttpHeaders) {
      status = nextStatus
      for (const [name, value] of Object.entries(nextHeaders ?? {})) {
        if (value !== undefined) headers.set(name.toLowerCase(), String(value))
      }
      return res
    },
    end(chunk?: string) {
      if (chunk !== undefined) body = JSON.parse(chunk)
      return res
    },
    get capture() { return { status, headers, body } },
  }
  return res as unknown as CapturedResponse
}
