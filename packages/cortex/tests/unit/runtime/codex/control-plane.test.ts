import { describe, expect, it } from 'vitest'
import {
  CodexControlPlaneInputError,
  ManagedCodexRuntimeControlPlane,
  type CodexControlPlaneClient,
} from '../../../../src/runtime/codex/control-plane.js'
import type {
  CodexDiagnostics,
  CodexInbound,
} from '../../../../src/runtime/codex/app-server-client.js'

class FakeClient implements CodexControlPlaneClient {
  readonly calls: Array<{ method: string; params: unknown }> = []
  readonly rejectedServerRequests: Array<{ id: string | number; code: number }> = []
  private readonly inbound: CodexInbound[] = []
  private readonly waiters: Array<(value: CodexInbound | undefined) => void> = []
  closed = false
  account: unknown = { account: null, requiresOpenaiAuth: true }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'account/read') return this.account
    if (method === 'account/rateLimits/read') {
      return {
        rateLimits: {
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resetsAt: 1_800_000_000,
          },
        },
      }
    }
    if (method === 'account/login/start') {
      return params && (params as Record<string, unknown>)['type'] === 'chatgpt'
        ? {
            type: 'chatgpt',
            loginId: 'login-secret-id',
            authUrl: 'https://example.test/login?one-time=true',
          }
        : {
            type: 'chatgptDeviceCode',
            loginId: 'login-secret-id',
            verificationUrl: 'https://example.test/device',
            userCode: 'ABCD-EFGH',
          }
    }
    if (method === 'account/login/cancel') return { status: 'cancelled' }
    if (method === 'account/logout') {
      this.account = { account: null, requiresOpenaiAuth: true }
      return {}
    }
    if (method === 'model/list') {
      return {
        data: [{
          id: 'gpt-test',
          model: 'gpt-test',
          displayName: 'GPT Test',
          description: 'Fixture model',
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Low' },
            { reasoningEffort: 'medium', description: 'Medium' },
          ],
          inputModalities: ['text'],
          supportsPersonality: false,
          serviceTiers: [],
          defaultServiceTier: null,
        }],
        nextCursor: null,
      }
    }
    throw new Error(`Unexpected method ${method}`)
  }

  nextInbound(timeoutMs = 0): Promise<CodexInbound | undefined> {
    const next = this.inbound.shift()
    if (next !== undefined) return Promise.resolve(next)
    return new Promise((resolve) => {
      const waiter = (value: CodexInbound | undefined): void => {
        clearTimeout(timer)
        resolve(value)
      }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(undefined)
      }, timeoutMs)
    })
  }

  push(value: CodexInbound): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(value)
    else this.inbound.push(value)
  }

  async respondError(id: string | number, code: number): Promise<void> {
    this.rejectedServerRequests.push({ id, code })
  }

  diagnostics(): CodexDiagnostics {
    return {
      state: this.closed ? 'closed' : 'running',
      version: '0.147.0',
      pid: 123,
      stderrBytes: 0,
      failureCode: null,
      exitCode: null,
      signal: null,
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
}

function controller(client: FakeClient): ManagedCodexRuntimeControlPlane {
  return new ManagedCodexRuntimeControlPlane({
    startClient: async () => client,
  })
}

describe('ManagedCodexRuntimeControlPlane', () => {
  it('does not start Codex when a shared consumer asks only for cached state', async () => {
    const client = new FakeClient()
    const control = controller(client)

    expect(control.cachedObservation()).toBeNull()
    expect(client.calls).toEqual([])

    await control.status()
    expect(control.cachedObservation()).toMatchObject({
      status: { account: { state: 'signed_out' } },
    })
    expect(control.cachedObservation()).not.toHaveProperty('catalog')
    await control.close()
  })

  it('returns a redacted signed-out snapshot without reading models or quota', async () => {
    const client = new FakeClient()
    const control = controller(client)

    await expect(control.status()).resolves.toEqual({
      runtime: {
        id: 'openai-codex',
        accessRoute: 'openai-chatgpt-managed',
        support: 'experimental',
        upstreamSupport: 'experimental_unsupported_for_production',
        processState: 'running',
        protocolVersion: '0.147.0',
        supportedVersionRange: '>=0.145.0 <0.146.0 || >=0.147.0 <0.148.0',
      },
      account: expect.objectContaining({ state: 'signed_out' }),
      login: { phase: 'idle' },
      quota: { state: 'unknown', reason: 'not_read', validUntil: null },
    })
    expect(client.calls.map((call) => call.method)).toEqual(['account/read'])
    await control.close()
  })

  it('correlates a one-time browser login and never retains its URL or identity in status', async () => {
    const client = new FakeClient()
    const control = controller(client)
    const presentation = await control.startLogin('browser')
    expect(presentation).toEqual({
      kind: 'browser',
      loginId: 'login-secret-id',
      url: 'https://example.test/login?one-time=true',
    })

    const waiting = control.waitForLogin(1_000)
    client.account = {
      account: {
        type: 'chatgpt',
        email: 'identity-must-not-leave@example.test',
        planType: 'plus',
      },
      requiresOpenaiAuth: true,
    }
    client.push({
      kind: 'notification',
      message: {
        method: 'account/login/completed',
        params: {
          loginId: 'login-secret-id',
          success: true,
          error: null,
          onboardingEntrypoint: null,
        },
      },
    })

    const status = await waiting
    expect(status.login).toEqual({ phase: 'succeeded' })
    expect(status.account).toMatchObject({
      state: 'authenticated',
      authMode: 'chatgpt',
      plan: 'plus',
    })
    expect(JSON.stringify(status)).not.toContain('identity-must-not-leave')
    expect(JSON.stringify(status)).not.toContain('one-time=true')
    expect(JSON.stringify(status)).not.toContain('login-secret-id')
    await control.close()
  })

  it('lists only the provider-observed model catalogue after refreshing account authority', async () => {
    const client = new FakeClient()
    client.account = {
      account: { type: 'chatgpt', email: null, planType: 'team' },
      requiresOpenaiAuth: true,
    }
    const control = controller(client)

    await expect(control.models()).resolves.toMatchObject({
      authority: 'model/list',
      models: [{ id: 'gpt-test', isDefault: true }],
    })
    expect(client.calls.map((call) => call.method)).toEqual([
      'account/read',
      'model/list',
    ])
    await control.close()
  })

  it('fails invalid long-poll input before waiting', async () => {
    const client = new FakeClient()
    const control = controller(client)
    await expect(control.waitForLogin(25_001)).rejects.toEqual(
      new CodexControlPlaneInputError('invalid_wait'),
    )
    await control.close()
  })

  it('rejects unexpected app-server requests instead of approving them', async () => {
    const client = new FakeClient()
    const control = controller(client)
    await control.status()
    client.push({
      kind: 'server_request',
      message: { id: 99, method: 'dangerous/request', params: {} },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.rejectedServerRequests).toEqual([{ id: 99, code: -32601 }])
    await control.close()
  })
})
