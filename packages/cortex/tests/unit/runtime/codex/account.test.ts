import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  CodexAccountUnavailableError,
  CodexAccountProtocolError,
  CodexAccountService,
  type CodexAccountRpc,
} from '../../../../src/runtime/codex/account.js'

const NOW = Date.parse('2026-07-26T18:00:00.000Z')

class ScriptedRpc implements CodexAccountRpc {
  readonly calls: Array<{ method: string; params: unknown }> = []
  readonly responses = new Map<string, unknown | Error>()

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params })
    const response = this.responses.get(method)
    if (response instanceof Error) throw response
    return response
  }
}

class QueueRpc implements CodexAccountRpc {
  readonly calls: Array<{ method: string; params: unknown }> = []
  constructor(private readonly queue: unknown[]) {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params })
    return this.queue.shift()
  }
}

function service(rpc = new ScriptedRpc()): {
  readonly rpc: ScriptedRpc
  readonly account: CodexAccountService
} {
  return {
    rpc,
    account: new CodexAccountService(rpc, { now: () => NOW }),
  }
}

const CHATGPT_ACCOUNT = {
  account: {
    type: 'chatgpt',
    email: 'private@example.test',
    planType: 'pro',
  },
  requiresOpenaiAuth: true,
}

const MODELS = {
  data: [
    {
      id: 'gpt-a',
      model: 'gpt-a',
      displayName: 'GPT A',
      description: 'First',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'medium', description: 'Balanced' },
        { reasoningEffort: 'high', description: 'Deep' },
      ],
      inputModalities: ['text', 'image'],
      serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast lane' }],
      defaultServiceTier: null,
      supportsPersonality: true,
      futureField: 'ignored without changing meaning',
    },
  ],
  nextCursor: null,
}

const RATE_LIMITS = {
  rateLimits: {
    limitId: 'codex',
    limitName: 'Codex',
    planType: 'pro',
    primary: {
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: 1_785_067_200,
    },
    secondary: {
      usedPercent: 40,
      windowDurationMins: 10_080,
      resetsAt: 1_785_672_000,
    },
    credits: {
      hasCredits: true,
      unlimited: false,
      balance: 'private-balance-not-for-output',
    },
    individualLimit: {
      limit: 'private-limit-not-for-output',
      used: 'private-used-not-for-output',
      remainingPercent: 75,
      resetsAt: 1_787_486_400,
    },
    rateLimitReachedType: null,
    spendControlReached: false,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: {
    availableCount: 2,
    credits: null,
  },
}

describe('Codex account authority and redaction', () => {
  it('refreshes through Codex and reports authenticated without retaining email', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/read', CHATGPT_ACCOUNT)

    await expect(account.readAccount({ refreshToken: true })).resolves.toEqual({
      state: 'authenticated',
      authMode: 'chatgpt',
      plan: 'pro',
      requiresOpenaiAuth: true,
      observedAt: '2026-07-26T18:00:00.000Z',
      validUntil: null,
      authority: 'account/read',
    })
    expect(rpc.calls).toEqual([
      { method: 'account/read', params: { refreshToken: true } },
    ])
    expect(JSON.stringify(account.accountSnapshot())).not.toContain('private@example')
  })

  it('distinguishes signed out from a non-subscription auth mode', async () => {
    const signedOut = service()
    signedOut.rpc.responses.set('account/read', {
      account: null,
      requiresOpenaiAuth: true,
    })
    await expect(signedOut.account.readAccount()).resolves.toMatchObject({
      state: 'signed_out',
    })

    const apiKey = service()
    apiKey.rpc.responses.set('account/read', {
      account: { type: 'apiKey' },
      requiresOpenaiAuth: true,
    })
    await expect(apiKey.account.readAccount()).resolves.toMatchObject({
      state: 'unsupported_auth',
      authMode: 'apiKey',
    })
  })

  it('fails an unknown account shape instead of treating it as authenticated', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/read', {
      account: { type: 'future-auth', credential: 'secret' },
      requiresOpenaiAuth: true,
    })

    await expect(account.readAccount()).rejects.toMatchObject({
      name: 'CodexAccountProtocolError',
      code: 'unknown_account_shape',
    })
    expect(JSON.stringify(account.accountSnapshot())).not.toContain('secret')
  })

  it('does not turn a transport failure into signed out or cancelled', async () => {
    const { rpc, account } = service()
    const network = new Error('network unavailable')
    rpc.responses.set('account/read', network)

    await expect(account.readAccount()).rejects.toBe(network)
    expect(account.accountSnapshot().state).toBe('unknown')
  })

  it('makes a later provider-confirmed revocation visible', async () => {
    const rpc = new QueueRpc([
      CHATGPT_ACCOUNT,
      { account: null, requiresOpenaiAuth: true },
    ])
    const account = new CodexAccountService(rpc, { now: () => NOW })

    await expect(account.readAccount()).resolves.toMatchObject({
      state: 'authenticated',
    })
    await expect(account.readAccount()).resolves.toMatchObject({
      state: 'signed_out',
    })
  })

  it('refreshes immediately before a turn and fails fast after revocation', async () => {
    const rpc = new QueueRpc([
      CHATGPT_ACCOUNT,
      { account: null, requiresOpenaiAuth: true },
    ])
    const account = new CodexAccountService(rpc, { now: () => NOW })

    await expect(account.authorizeTurnAttempt()).resolves.toMatchObject({
      state: 'authenticated',
      plan: 'pro',
    })
    await expect(account.authorizeTurnAttempt()).rejects.toMatchObject({
      name: 'CodexAccountUnavailableError',
      code: 'account_signed_out',
    })
    expect(rpc.calls).toEqual([
      { method: 'account/read', params: { refreshToken: true } },
      { method: 'account/read', params: { refreshToken: true } },
    ])
  })

  it('derives only an opaque keyed account binding for safe resume checks', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/read', CHATGPT_ACCOUNT)
    const key = Buffer.alloc(32, 7)

    await account.authorizeTurnAttempt()
    const binding = account.accountBinding(key)

    expect(binding).toMatch(/^hmac-sha256:[a-f0-9]{64}$/)
    expect(binding).toBe(account.accountBinding(key))
    expect(binding).not.toContain('private@example')
    expect(account.accountBinding(randomBytes(32))).not.toBe(binding)
  })

  it('refuses an account binding when Codex reports no stable account identity', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/read', {
      account: {
        type: 'chatgpt',
        email: null,
        planType: 'pro',
      },
      requiresOpenaiAuth: true,
    })

    await account.authorizeTurnAttempt()
    expect(() => account.accountBinding(Buffer.alloc(32, 1))).toThrowError(
      expect.objectContaining({ code: 'account_identity_unavailable' }),
    )
    expect(() => account.accountBinding(Buffer.alloc(8))).toThrowError(
      expect.objectContaining({ code: 'account_binding_key_invalid' }),
    )
  })

  it('clears volatile account identity after a provider-confirmed sign-out', async () => {
    const rpc = new QueueRpc([
      CHATGPT_ACCOUNT,
      { account: null, requiresOpenaiAuth: true },
    ])
    const account = new CodexAccountService(rpc, { now: () => NOW })
    const key = Buffer.alloc(32, 9)

    await account.readAccount()
    expect(account.accountBinding(key)).toMatch(/^hmac-sha256:/)
    await account.readAccount()
    expect(() => account.accountBinding(key)).toThrowError(
      expect.objectContaining({ code: 'account_identity_unavailable' }),
    )
  })
})

describe('Codex-managed browser and device login', () => {
  it('starts browser login and keeps its URL out of inspectable state', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/login/start', {
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/login?state=sensitive-state',
    })

    await expect(account.startLogin('browser')).resolves.toEqual({
      kind: 'browser',
      loginId: 'login-1',
      url: 'https://chatgpt.com/login?state=sensitive-state',
    })
    expect(rpc.calls.at(-1)).toEqual({
      method: 'account/login/start',
      params: {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt',
      },
    })
    expect(account.loginSnapshot()).toEqual({
      phase: 'pending',
      loginId: 'login-1',
    })
    expect(JSON.stringify(account.loginSnapshot())).not.toContain('sensitive-state')
  })

  it('starts device login and returns the one-time presentation only to the caller', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/login/start', {
      type: 'chatgptDeviceCode',
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })

    await expect(account.startLogin('device')).resolves.toEqual({
      kind: 'device',
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    expect(JSON.stringify(account.loginSnapshot())).not.toContain('ABCD-1234')
  })

  it('accepts only the matching completion and discards raw provider error text', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/login/start', {
      type: 'chatgpt',
      loginId: 'login-current',
      authUrl: 'https://chatgpt.com/login',
    })
    await account.startLogin('browser')

    expect(account.observeNotification({
      method: 'account/login/completed',
      params: {
        loginId: 'login-old',
        success: true,
        error: null,
      },
    })).toEqual({ handled: true, status: 'stale' })
    expect(account.loginSnapshot().phase).toBe('pending')

    expect(account.observeNotification({
      method: 'account/login/completed',
      params: {
        loginId: 'login-current',
        success: false,
        error: 'raw provider detail with private@example.test',
      },
    })).toEqual({ handled: true, status: 'failed' })
    expect(account.loginSnapshot()).toEqual({
      phase: 'failed',
      reason: 'provider_rejected',
    })
    expect(JSON.stringify(account.loginSnapshot())).not.toContain('private@example')
  })

  it('distinguishes a requested cancellation and sends the exact login id', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/login/start', {
      type: 'chatgptDeviceCode',
      loginId: 'device-current',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ONCE',
    })
    rpc.responses.set('account/login/cancel', {})
    await account.startLogin('device')
    await account.cancelLogin()

    expect(rpc.calls.at(-1)).toEqual({
      method: 'account/login/cancel',
      params: { loginId: 'device-current' },
    })
    expect(account.loginSnapshot()).toEqual({
      phase: 'cancelling',
      loginId: 'device-current',
    })
    expect(account.observeNotification({
      method: 'account/login/completed',
      params: {
        loginId: 'device-current',
        success: false,
        error: 'cancelled',
      },
    })).toEqual({ handled: true, status: 'cancelled' })
    expect(account.loginSnapshot()).toEqual({ phase: 'cancelled' })
  })

  it('rejects a second login while one is pending', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/login/start', {
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/login',
    })
    await account.startLogin('browser')
    await expect(account.startLogin('device')).rejects.toMatchObject({
      code: 'login_in_progress',
    })
  })

  it('leaves login idle when the browser flow cannot be started', async () => {
    const { rpc, account } = service()
    const unavailable = new Error('browser login service unavailable')
    rpc.responses.set('account/login/start', unavailable)

    await expect(account.startLogin('browser')).rejects.toBe(unavailable)
    expect(account.loginSnapshot()).toEqual({ phase: 'idle' })
  })

  it('rejects a non-HTTPS login URL before presenting it', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/login/start', {
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'http://attacker.test/capture',
    })

    await expect(account.startLogin('browser')).rejects.toMatchObject({
      code: 'invalid_login_response',
    })
    expect(account.loginSnapshot()).toEqual({ phase: 'idle' })
  })

  it('treats account/updated as a refresh signal, not proof of authentication', () => {
    const { account } = service()
    expect(account.observeNotification({
      method: 'account/updated',
      params: { authMode: 'chatgpt', planType: 'pro' },
    })).toEqual({ handled: true, status: 'refresh_required' })
    expect(account.accountSnapshot()).toEqual({
      state: 'unknown',
      reason: 'not_read',
    })
  })
})

describe('Codex model catalogue', () => {
  it('uses model/list, preserves provider order, and exposes no API-key catalogue defaults', async () => {
    const { rpc, account } = service()
    rpc.responses.set('model/list', MODELS)

    const catalog = await account.listModels()
    expect(catalog).toMatchObject({
      authority: 'model/list',
      observedAt: '2026-07-26T18:00:00.000Z',
      validUntil: null,
      models: [{
        id: 'gpt-a',
        model: 'gpt-a',
        isDefault: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        inputModalities: ['text', 'image'],
        serviceTiers: ['priority'],
      }],
    })
    expect(rpc.calls[0]).toEqual({
      method: 'model/list',
      params: { includeHidden: false, limit: 100 },
    })
  })

  it('paginates by the provider cursor', async () => {
    const rpc = new QueueRpc([
      { ...MODELS, nextCursor: 'page-2' },
      { data: [], nextCursor: null },
    ])
    const account = new CodexAccountService(rpc, { now: () => NOW })

    await expect(account.listModels()).resolves.toMatchObject({
      models: [{ id: 'gpt-a' }],
    })
    expect(rpc.calls[1]).toEqual({
      method: 'model/list',
      params: { includeHidden: false, limit: 100, cursor: 'page-2' },
    })
  })

  it('replaces the snapshot when the provider removes a model', async () => {
    const rpc = new QueueRpc([
      MODELS,
      { data: [], nextCursor: null },
    ])
    const account = new CodexAccountService(rpc, { now: () => NOW })

    await expect(account.listModels()).resolves.toMatchObject({
      models: [{ id: 'gpt-a' }],
    })
    await expect(account.listModels()).resolves.toMatchObject({ models: [] })
    expect(account.modelSnapshot()?.models).toEqual([])
    expect(() => account.requireModel('gpt-a')).toThrowError(
      expect.objectContaining({ code: 'model_unavailable' }),
    )
  })

  it('requires an authoritative catalogue before accepting a model', () => {
    const { account } = service()
    expect(() => account.requireModel('gpt-a')).toThrowError(
      expect.objectContaining({ code: 'model_catalog_not_read' }),
    )
  })

  it('rejects duplicate model ids instead of making selection ambiguous', async () => {
    const { rpc, account } = service()
    rpc.responses.set('model/list', {
      data: [MODELS.data[0], { ...MODELS.data[0], model: 'other' }],
      nextCursor: null,
    })
    await expect(account.listModels()).rejects.toMatchObject({
      code: 'duplicate_model',
    })
  })
})

describe('Codex rate-limit authority', () => {
  it('reports provider windows without private balances or fabricated cost', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/rateLimits/read', RATE_LIMITS)

    const quota = await account.readRateLimits()
    expect(quota).toMatchObject({
      state: 'reported',
      authority: 'account/rateLimits/read',
      observedAt: '2026-07-26T18:00:00.000Z',
      validUntil: null,
      resetCreditsAvailable: 2,
      resetCreditDetailsKnown: false,
      buckets: [{
        id: 'codex',
        primary: {
          usedPercent: 25,
          windowDurationMinutes: 300,
          resetsAt: '2026-07-26T12:00:00.000Z',
        },
        secondary: { usedPercent: 40 },
        hasCredits: true,
        unlimitedCredits: false,
        spendRemainingPercent: 75,
        spendControlReached: false,
      }],
    })
    const serialized = JSON.stringify(quota)
    expect(serialized).not.toContain('private-balance')
    expect(serialized).not.toContain('private-limit')
    expect(serialized).not.toMatch(/amount|cost|price/i)
  })

  it('reports unknown when the provider supplies no allowance signal', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/rateLimits/read', {
      rateLimits: {},
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      futureQuotaField: { remaining: 0 },
    })

    await expect(account.readRateLimits()).resolves.toEqual({
      state: 'unknown',
      reason: 'provider_stated_no_usable_limit',
      authority: 'account/rateLimits/read',
      observedAt: '2026-07-26T18:00:00.000Z',
      validUntil: null,
    })
  })

  it('treats a provider limit signal as exhausted without guessing a reset', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/rateLimits/read', {
      rateLimits: {
        primary: { usedPercent: 100, resetsAt: null, windowDurationMins: null },
        rateLimitReachedType: 'future_limit_kind',
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    })

    await expect(account.readRateLimits()).resolves.toMatchObject({
      state: 'exhausted',
      buckets: [{
        reachedType: 'future_limit_kind',
        primary: { usedPercent: 100, resetsAt: null },
      }],
    })
  })

  it('merges sparse updates without clearing previously known nullable values', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/rateLimits/read', RATE_LIMITS)
    await account.readRateLimits()

    const result = account.observeNotification({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 30 },
          secondary: null,
          spendControlReached: null,
        },
      },
    })

    expect(result).toEqual({ handled: true, status: 'updated' })
    expect(account.quotaSnapshot()).toMatchObject({
      state: 'reported',
      authority: 'account/rateLimits/updated',
      buckets: [{
        primary: {
          usedPercent: 30,
          windowDurationMinutes: 300,
        },
        secondary: { usedPercent: 40 },
        spendControlReached: false,
      }],
    })
  })

  it('degrades an unparseable provider snapshot to unknown, never zero', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/rateLimits/read', {
      rateLimits: {
        primary: { usedPercent: 'many' },
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    })

    await expect(account.readRateLimits()).resolves.toMatchObject({
      state: 'unknown',
      reason: 'unrecognized_provider_shape',
    })
    expect(account.quotaSnapshot()).not.toHaveProperty('buckets')
    expect(account.quotaSnapshot()).not.toHaveProperty('remaining')
  })
})

describe('logout confirmation', () => {
  it('claims signed out only after account/read confirms it', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/logout', {})
    rpc.responses.set('account/read', {
      account: null,
      requiresOpenaiAuth: true,
    })

    await expect(account.logout()).resolves.toMatchObject({ state: 'signed_out' })
    expect(rpc.calls.map((call) => call.method)).toEqual([
      'account/logout',
      'account/read',
    ])
  })

  it('fails when logout returns but the account remains authenticated', async () => {
    const { rpc, account } = service()
    rpc.responses.set('account/logout', {})
    rpc.responses.set('account/read', CHATGPT_ACCOUNT)

    await expect(account.logout()).rejects.toMatchObject({
      code: 'logout_unconfirmed',
    })
    expect(account.accountSnapshot().state).toBe('authenticated')
  })
})

describe('protocol error shape', () => {
  it('contains only a stable code', () => {
    const error = new CodexAccountProtocolError('unknown_account_shape')
    expect(error).toEqual(expect.objectContaining({
      name: 'CodexAccountProtocolError',
      code: 'unknown_account_shape',
      message: 'Codex account protocol failed (unknown_account_shape).',
    }))
    expect(error).not.toHaveProperty('payload')
  })

  it('keeps availability errors content-free', () => {
    const error = new CodexAccountUnavailableError('account_signed_out')
    expect(error).toEqual(expect.objectContaining({
      name: 'CodexAccountUnavailableError',
      code: 'account_signed_out',
      message: 'Codex subscription is unavailable (account_signed_out).',
    }))
  })
})
