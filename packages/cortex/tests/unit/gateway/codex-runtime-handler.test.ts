import { Readable } from 'node:stream'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createCodexRuntimeHandlers } from '../../../src/gateway/handlers/codex-runtime.js'
import { setRequestPrincipal } from '../../../src/gateway/auth/scoped-principal.js'
import { CodexProcessError } from '../../../src/runtime/codex/app-server-client.js'
import type { CodexRuntimeControlPlane } from '../../../src/runtime/codex/control-plane.js'

function request(body?: unknown): IncomingMessage {
  const stream = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  )
  Object.assign(stream, { headers: { host: 'localhost' } })
  return stream as unknown as IncomingMessage
}

function response(): {
  readonly res: ServerResponse
  readonly result: () => { status: number; headers: Record<string, unknown>; body: unknown }
} {
  let status = 0
  const headers: Record<string, unknown> = {}
  let body = ''
  const res = {
    headersSent: false,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value
    },
    writeHead(code: number, extra?: OutgoingHttpHeaders) {
      status = code
      Object.assign(headers, extra)
      this.headersSent = true
      return this
    },
    end(chunk?: string) {
      if (chunk !== undefined) body += chunk
      this.headersSent = true
    },
  } as unknown as ServerResponse
  return {
    res,
    result: () => ({
      status,
      headers,
      body: body.length === 0 ? null : JSON.parse(body),
    }),
  }
}

function fakeControl(): CodexRuntimeControlPlane {
  return {
    cachedObservation: vi.fn(() => null),
    status: vi.fn(async () => ({
      runtime: {
        id: 'openai-codex',
        accessRoute: 'openai-chatgpt-managed',
        support: 'experimental',
        upstreamSupport: 'experimental_unsupported_for_production',
        processState: 'running',
        protocolVersion: '0.147.0',
        supportedVersionRange: '>=0.145.0 <0.146.0 || >=0.147.0 <0.148.0',
      },
      account: { state: 'unknown', reason: 'not_read' },
      login: { phase: 'idle' },
      quota: { state: 'unknown', reason: 'not_read', validUntil: null },
    })),
    startLogin: vi.fn(async () => ({
      kind: 'device',
      loginId: 'login-id',
      verificationUrl: 'https://example.test/device',
      userCode: 'ABCD-EFGH',
    })),
    waitForLogin: vi.fn(async () => {
      throw new Error('unused')
    }),
    cancelLogin: vi.fn(async () => {
      throw new Error('unused')
    }),
    logout: vi.fn(async () => {
      throw new Error('unused')
    }),
    models: vi.fn(async () => ({
      authority: 'model/list',
      observedAt: '2026-08-09T00:00:00.000Z',
      validUntil: null,
      models: [],
    })),
    close: vi.fn(async () => undefined),
  }
}

describe('Codex runtime gateway handlers', () => {
  it('allows the local install owner and marks every response no-store', async () => {
    const controlPlane = fakeControl()
    const handlers = createCodexRuntimeHandlers({
      controlPlane,
      authEnabled: false,
    })
    const output = response()

    await handlers.status(request(), output.res)

    expect(output.result()).toMatchObject({
      status: 200,
      headers: { 'cache-control': 'no-store' },
      body: { runtime: { protocolVersion: '0.147.0' } },
    })
    expect(controlPlane.status).toHaveBeenCalledOnce()
  })

  it('requires the authenticated install owner when gateway auth is enabled', async () => {
    const controlPlane = fakeControl()
    const handlers = createCodexRuntimeHandlers({
      controlPlane,
      authEnabled: true,
    })
    const output = response()

    await handlers.status(request(), output.res)

    expect(output.result()).toMatchObject({
      status: 403,
      body: { error: 'owner_required', category: 'auth' },
    })
    expect(controlPlane.status).not.toHaveBeenCalled()
  })

  it('denies delegated callers even if they name the runtime operation', async () => {
    const controlPlane = fakeControl()
    const handlers = createCodexRuntimeHandlers({
      controlPlane,
      authEnabled: false,
    })
    const req = request()
    setRequestPrincipal(req, {
      kind: 'delegated',
      tokenId: 'token',
      delegateId: 'delegate',
      workspaceId: 'workspace',
      profileId: 'profile',
      purpose: 'test',
      operations: ['runtimes.codex.read'],
      issuedAt: 1,
      expiresAt: 2,
    })
    const output = response()

    await handlers.status(req, output.res)

    expect(output.result()).toMatchObject({ status: 403 })
    expect(controlPlane.status).not.toHaveBeenCalled()
  })

  it('validates login input before invoking Codex', async () => {
    const controlPlane = fakeControl()
    const handlers = createCodexRuntimeHandlers({
      controlPlane,
      authEnabled: false,
    })
    const output = response()

    await handlers.startLogin(request({ kind: 'magic', extra: true }), output.res)

    expect(output.result()).toMatchObject({
      status: 400,
      body: { error: 'codex_request_invalid' },
    })
    expect(controlPlane.startLogin).not.toHaveBeenCalled()
  })

  it('returns one-time device login material only from the start response', async () => {
    const controlPlane = fakeControl()
    const handlers = createCodexRuntimeHandlers({
      controlPlane,
      authEnabled: false,
    })
    const output = response()

    await handlers.startLogin(request({ kind: 'device' }), output.res)

    expect(output.result()).toMatchObject({
      status: 200,
      headers: { 'cache-control': 'no-store' },
      body: {
        kind: 'device',
        verificationUrl: 'https://example.test/device',
        userCode: 'ABCD-EFGH',
      },
    })
  })

  it('maps unsupported binaries to a stable content-free compatibility error', async () => {
    const controlPlane = fakeControl()
    vi.mocked(controlPlane.status).mockRejectedValueOnce(
      new CodexProcessError('incompatible_version'),
    )
    const handlers = createCodexRuntimeHandlers({
      controlPlane,
      authEnabled: false,
    })
    const output = response()

    await handlers.status(request(), output.res)

    expect(output.result()).toMatchObject({
      status: 409,
      body: {
        error: 'codex_version_unsupported',
        category: 'config',
        supportedVersionRange: '>=0.145.0 <0.146.0 || >=0.147.0 <0.148.0',
      },
    })
  })
})
